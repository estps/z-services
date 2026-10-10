#!/usr/bin/env python3
"""zsparx - a small personal API for Sparx Maths (Nassau... no: NAS Dubai).

Logs in through the school's Microsoft account with a persistent headless
Chrome profile, then replays the web app's own authenticated calls:

    GET  /health          - service + login state
    GET  /session         - school/session JSON
    GET  /xp              - current XP state
    GET  /userinfo        - name, email, school
    GET  /homework        - homework packages (decoded from protobuf tree)
    GET  /notifications   - notifications
    POST /login           - force a fresh Microsoft login
    GET  /raw?p=/path     - arbitrary gRPC-web call (optional ?b=<base64 body>)

Every request must carry:  x-zsparx-token: <token from state/api-token.txt>
"""

import base64
import json
import os
import re
import secrets
import struct
import threading
import time
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By

ROOT = Path(__file__).resolve().parent
STATE = ROOT / "state"
PROFILE = ROOT / "profile"
CREDS_PATH = ROOT / "creds.json"
TOKEN_PATH = STATE / "api-token.txt"

PORT = int(os.environ.get("PORT", "8823"))
API = "https://api.sparx-learning.com"
DASH = "https://maths.sparx-learning.com/student"
SELECT_SCHOOL = (
    "https://selectschool.sparx-learning.com/?app=sparx_learning"
    "&route=https%3A%2F%2Fmaths.sparx-learning.com%2Fstudent"
)

RPC_XP = "/maths/sparx.maths.xp.v1.XP/GetCurrentUserXPState"
RPC_USERINFO = "/sparx.auth.userinfo.v1.UserInfoService/GetUserInfo"
RPC_NOTIFICATIONS = "/sparx.notifications.notifications.v1.Notifications/ListNotificationsAndDisplayData"
RPC_PACKAGES = "/maths/sparx.packageactivity.v1.Packages/ListStudentPackages"

# DeepSeek powers POST /ask - "answer this for me".
DEEPSEEK_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_URL = os.environ.get("DEEPSEEK_URL", "https://api.deepseek.com/chat/completions")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
DEEPSEEK_SYSTEM = os.environ.get(
    "DEEPSEEK_SYSTEM",
    "You are a helpful assistant. Answer the user's question directly and correctly. "
    "For maths or science show the working and steps, then the final answer.",
)


def ask_deepseek(question, context=None, system=None):
    if not DEEPSEEK_KEY:
        raise RuntimeError("DEEPSEEK_API_KEY is not configured")
    messages = [{"role": "system", "content": system or DEEPSEEK_SYSTEM}]
    user = question if not context else "Context:\n%s\n\nQuestion:\n%s" % (context, question)
    messages.append({"role": "user", "content": user})
    body = json.dumps(
        {
            "model": DEEPSEEK_MODEL,
            "messages": messages,
            "max_tokens": int(os.environ.get("DEEPSEEK_MAX_TOKENS", "2048")),
            "temperature": 0.3,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        DEEPSEEK_URL,
        data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + DEEPSEEK_KEY},
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        data = json.loads(response.read().decode("utf-8"))
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("deepseek returned no answer: %s" % json.dumps(data)[:200])
    return choices[0].get("message", {}).get("content", "")

LOGIN_JS = """
const done = arguments[0];
fetch('https://api.sparx-learning.com/token', {credentials: 'include'})
  .then(r => r.text().then(t => done({status: r.status, body: t})))
  .catch(e => done({error: String(e)}));
"""

SESSION_JS = """
const done = arguments[0];
fetch('https://api.sparx-learning.com/session', {credentials: 'include'})
  .then(r => r.text().then(t => done({status: r.status, ct: r.headers.get('content-type'), body: t})))
  .catch(e => done({error: String(e)}));
"""

RPC_JS = """
const url = arguments[0];
const bearer = arguments[1];
const bodyB64 = arguments[2];
const done = arguments[3];
const t = setTimeout(() => done({error: 'timeout'}), 25000);
const bin = atob(bodyB64);
const arr = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/grpc-web+proto',
    'x-grpc-web': '1',
    'authorization': bearer
  },
  body: arr,
  credentials: 'include'
}).then(async (r) => {
  clearTimeout(t);
  let hex = '';
  try {
    const buf = await r.arrayBuffer();
    const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, '0');
  } catch (e) {}
  done({
    status: r.status,
    grpc: r.headers.get('grpc-status'),
    grpcmsg: r.headers.get('grpc-message'),
    hex: hex
  });
}).catch((e) => {
  clearTimeout(t);
  done({error: String(e)});
});
"""


# ---------------------------------------------------------------- protobuf-ish

def read_varint(data, i):
    shift = 0
    value = 0
    while True:
        if i >= len(data):
            raise ValueError("eof")
        byte = data[i]
        i += 1
        value |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return value, i
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")


def decode_chunk(chunk):
    try:
        text = chunk.decode("utf-8")
        if text and all(ch.isprintable() or ch in "\n\r\t" for ch in text):
            return text
    except Exception:
        pass
    parsed = try_parse_message(chunk)
    if parsed is not None:
        return parsed
    return "0x" + chunk.hex()


def try_parse_message(data):
    fields = {}
    i = 0
    try:
        while i < len(data):
            key, i = read_varint(data, i)
            field_no = key >> 3
            wire = key & 7
            if field_no == 0:
                return None
            if wire == 0:
                value, i = read_varint(data, i)
            elif wire == 2:
                length, i = read_varint(data, i)
                if i + length > len(data):
                    raise ValueError("eof")
                value = decode_chunk(data[i:i + length])
                i += length
            elif wire == 5:
                if i + 4 > len(data):
                    raise ValueError("eof")
                value = struct.unpack("<f", data[i:i + 4])[0]
                if value != value or value in (float("inf"), float("-inf")):
                    value = "0x" + data[i:i + 4].hex()
                i += 4
            elif wire == 1:
                if i + 8 > len(data):
                    raise ValueError("eof")
                value = struct.unpack("<d", data[i:i + 8])[0]
                if value != value or value in (float("inf"), float("-inf")):
                    value = "0x" + data[i:i + 8].hex()
                i += 8
            else:
                raise ValueError("wire")
            fields.setdefault(str(field_no), []).append(value)
    except Exception:
        return None
    if not fields:
        return None
    return {key: (val[0] if len(val) == 1 else val) for key, val in fields.items()}


def decode_grpc_web(hex_string):
    data = bytes.fromhex(hex_string)
    messages = []
    trailers = []
    i = 0
    while i + 5 <= len(data):
        flag = data[i]
        length = int.from_bytes(data[i + 1:i + 5], "big")
        i += 5
        chunk = data[i:i + length]
        i += length
        if flag & 0x80:
            trailers.append(chunk.decode("utf-8", "replace").strip())
        else:
            parsed = try_parse_message(chunk)
            messages.append(parsed if parsed is not None else "0x" + chunk.hex())
    return {"messages": messages, "trailers": trailers}


# ------------------------------------------------------------------- selenium

driver_lock = threading.Lock()
_driver = None


def get_driver():
    global _driver
    if _driver is not None:
        return _driver
    options = Options()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1440,900")
    options.add_argument("--user-data-dir=" + str(PROFILE))
    options.add_argument(
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    )
    _driver = webdriver.Chrome(options=options)
    _driver.set_page_load_timeout(60)
    _driver.set_script_timeout(35)
    return _driver


def drop_driver():
    global _driver
    try:
        if _driver is not None:
            _driver.quit()
    except Exception:
        pass
    _driver = None


def body_text():
    try:
        return _driver.find_element(By.TAG_NAME, "body").text or ""
    except Exception:
        return ""


def js_click(element):
    _driver.execute_script("arguments[0].click();", element)


def click_text(*words):
    for element in _driver.find_elements(
        By.CSS_SELECTOR, "button,a,input[type=submit],div[role=button]"
    ):
        try:
            if not element.is_displayed():
                continue
            text = (element.text or element.get_attribute("value") or "").strip().lower()
            if text in words:
                js_click(element)
                return True
        except Exception:
            pass
    return False


def visible_input(selector):
    for element in _driver.find_elements(By.CSS_SELECTOR, selector):
        try:
            if element.is_displayed():
                return element
        except Exception:
            pass
    return None


def logged_in_body():
    text = body_text()
    return "XP" in text and ("Homework" in text or "Welcome to Sparx" in text)


def ensure_logged_in(force=False):
    """True when the dashboard is reachable; runs the Microsoft flow if needed."""
    creds = json.loads(CREDS_PATH.read_text(encoding="utf-8"))
    driver = get_driver()
    if force:
        try:
            driver.delete_all_cookies()
        except Exception:
            pass
    driver.get(DASH)
    deadline = time.time() + 25
    while time.time() < deadline:
        if logged_in_body():
            return True
        time.sleep(1.5)

    # About to log in: start from the school selector if we were sent there.
    for element in driver.find_elements(By.CSS_SELECTOR, "#cookiescript_accept"):
        js_click(element)
        time.sleep(1)

    for round_number in range(16):
        url = driver.current_url
        body = body_text()
        print("[login] round", round_number, url[:100], flush=True)
        if logged_in_body():
            return True
        if "login.microsoftonline.com" not in url:
            # Still on a sparx page: press the Microsoft button / school step.
            if "selectschool" in url:
                box = visible_input("input[type=text]")
                if box is not None:
                    box.clear()
                    box.send_keys("Nord Anglia International School Dubai")
                    time.sleep(3)
                    clicked = False
                    for selector in ["li", "[role=option]"]:
                        for element in driver.find_elements(By.CSS_SELECTOR, selector):
                            text = (element.text or "").strip()
                            if "Nord Anglia International School Dubai" in text and "Hessa" in text:
                                js_click(element)
                                clicked = True
                                break
                        if clicked:
                            break
                    time.sleep(2)
                    click_text("continue")
                    time.sleep(5)
            elif "microsoft" in body.lower() or any(
                "microsoft" in (element.text or "").lower()
                for element in driver.find_elements(By.CSS_SELECTOR, "button,a")
            ):
                for element in driver.find_elements(By.CSS_SELECTOR, "button,a"):
                    if "microsoft" in (element.text or "").lower():
                        js_click(element)
                        time.sleep(6)
                        break
            else:
                time.sleep(4)
            continue
        if "Pick an account" in body:
            if click_text("use another account"):
                time.sleep(5)
                continue
        email = visible_input("input[name=loginfmt],input[type=email]")
        if email is not None:
            if not (email.get_attribute("value") or "").strip():
                email.clear()
                email.send_keys(creds["email"])
            click_text("next")
            time.sleep(6)
            continue
        password = visible_input("input[name=passwd],input[type=password]")
        if password is not None:
            password.clear()
            password.send_keys(creds["password"])
            click_text("sign in", "login")
            time.sleep(8)
            continue
        if "Stay signed in?" in body:
            click_text("yes")
            time.sleep(8)
            continue
        time.sleep(4)

    deadline = time.time() + 40
    while time.time() < deadline:
        if logged_in_body():
            return True
        time.sleep(2)
    return False


# ----------------------------------------------------------------- RPC helpers

_token_cache = {"value": "", "at": 0.0}


def current_bearer():
    now = time.time()
    if _token_cache["value"] and now - _token_cache["at"] < 240:
        return _token_cache["value"]
    result = _driver.execute_async_script(LOGIN_JS)
    body = (result or {}).get("body", "")
    if isinstance(body, str) and body.strip().lower().startswith("bearer "):
        _token_cache["value"] = body.strip()
        _token_cache["at"] = now
        return _token_cache["value"]
    raise RuntimeError("token fetch failed: %s" % json.dumps(result)[:200])


def rpc(path, body=b""):
    bearer = current_bearer()
    frame = b"\x00" + len(body).to_bytes(4, "big") + body
    result = _driver.execute_async_script(
        RPC_JS, API + path, bearer, base64.b64encode(frame).decode("ascii")
    )
    if not isinstance(result, dict):
        raise RuntimeError("rpc transport error: %r" % (result,))
    if result.get("grpc") not in (None, "0"):
        raise RuntimeError("grpc %s: %s" % (result.get("grpc"), result.get("grpcmsg")))
    if "hex" not in result or result.get("error"):
        raise RuntimeError("rpc failed: %s" % json.dumps(result)[:200])
    decoded = decode_grpc_web(result["hex"])
    for trailer in decoded["trailers"]:
        match = re.search(r"grpc-status:\s*(\d+)", trailer)
        if match and match.group(1) != "0":
            message = re.search(r"grpc-message:\s*(.*)", trailer)
            raise RuntimeError(
                "grpc %s: %s" % (match.group(1), message.group(1) if message else trailer[:120])
            )
    return decoded["messages"]


def with_session(work):
    """Serialize driver access, relogin once on failure, then retry."""
    with driver_lock:
        try:
            if not ensure_logged_in():
                raise RuntimeError("not logged in")
            return work()
        except Exception:
            print("[zsparx] first attempt failed:\n" + traceback.format_exc(), flush=True)
            drop_driver()
            if not ensure_logged_in(force=True):
                raise RuntimeError("login failed - check creds.json")
            return work()


def extract_xp(tree):
    try:
        inner = tree.get("1")
        if isinstance(inner, dict):
            value = inner.get("2")
            if isinstance(value, int):
                return value
            if isinstance(value, str) and value.isdigit():
                return int(value)
    except Exception:
        pass
    return None


# ---------------------------------------------------------------- HTTP server

class Handler(BaseHTTPRequestHandler):
    server_version = "zsparx/1.0"

    def log_message(self, fmt, *args):
        print("[http] " + (fmt % args), flush=True)

    def _send(self, code, payload):
        data = json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "x-zsparx-token, content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self):
        try:
            token = (TOKEN_PATH.read_text(encoding="utf-8").strip())
        except Exception:
            token = ""
        return self.headers.get("x-zsparx-token", "") == token and token != ""

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except Exception:
            length = 0
        raw = self.rfile.read(length) if length else b""
        return raw.decode("utf-8", "replace")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "x-zsparx-token, content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        path = parsed.path or "/"
        if path == "/sparx" or path.startswith("/sparx/"):
            path = path[len("/sparx"):] or "/"

        if path == "/health" and not self._authorized():
            # Unauthenticated health only reports the service is up.
            self._send(200, {"ok": True, "auth": False})
            return

        if not self._authorized():
            self._send(401, {"error": "missing or wrong x-zsparx-token"})
            return

        try:
            if path == "/health":
                self._send(200, {"ok": True, "auth": True})
            elif path == "/session":
                result = with_session(lambda: _driver.execute_async_script(SESSION_JS))
                if not isinstance(result, dict) or "body" not in result:
                    raise RuntimeError("session call failed: %r" % (result,))
                try:
                    self._send(200, json.loads(result["body"]))
                except Exception:
                    self._send(502, {"error": "bad session payload", "raw": result})
            elif path == "/xp":
                messages = with_session(lambda: rpc(RPC_XP))
                tree = messages[0] if messages else {}
                self._send(200, {"xp": extract_xp(tree) if isinstance(tree, dict) else None, "state": tree})
            elif path == "/userinfo":
                messages = with_session(lambda: rpc(RPC_USERINFO))
                self._send(200, {"userinfo": messages[0] if messages else None})
            elif path == "/homework":
                messages = with_session(lambda: rpc(RPC_PACKAGES))
                self._send(200, {"packages": messages[0] if messages else None})
            elif path == "/notifications":
                messages = with_session(lambda: rpc(RPC_NOTIFICATIONS))
                self._send(200, {"notifications": messages[0] if messages else None})
            elif path == "/raw":
                path = (query.get("p") or [""])[0]
                if not path.startswith("/"):
                    self._send(400, {"error": "add p=/rpc/path"})
                    return
                body = base64.b64decode((query.get("b") or [""])[0] or "")
                messages = with_session(lambda: rpc(path, body))
                self._send(200, {"messages": messages})
            elif path == "/ask":
                question = (query.get("q") or [""])[0].strip()
                if not question:
                    self._send(400, {"error": "add ?q=..."})
                else:
                    self._send(200, {"answer": ask_deepseek(question), "model": DEEPSEEK_MODEL})
            elif path == "/":
                self._send(200, {
                    "service": "zsparx",
                    "endpoints": ["/health", "/session", "/xp", "/userinfo", "/homework",
                                  "/notifications", "/raw?p=/rpc/path", "/ask?q=...",
                                  "POST /ask", "POST /login"],
                })
            else:
                self._send(404, {"error": "not found"})
        except Exception as error:
            self._send(502, {"error": str(error), "trace": traceback.format_exc()[-600:]})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path or "/"
        if path == "/sparx" or path.startswith("/sparx/"):
            path = path[len("/sparx"):] or "/"
        if not self._authorized():
            self._send(401, {"error": "missing or wrong x-zsparx-token"})
            return
        try:
            if path == "/login":
                with driver_lock:
                    drop_driver()
                    ok = ensure_logged_in(force=True)
                self._send(200 if ok else 502, {"logged_in": ok})
                return
            if path == "/ask":
                raw = self._read_body()
                try:
                    body = json.loads(raw) if raw else {}
                except Exception:
                    self._send(400, {"error": "bad json"})
                    return
                question = str(body.get("question") or body.get("prompt") or body.get("q") or "").strip()
                if not question:
                    self._send(400, {"error": "add question"})
                    return
                answer = ask_deepseek(question, body.get("context"), body.get("system"))
                self._send(200, {"answer": answer, "model": DEEPSEEK_MODEL})
                return
            self._send(404, {"error": "not found"})
        except Exception as error:
            self._send(502, {"error": str(error), "trace": traceback.format_exc()[-600:]})


def main():
    STATE.mkdir(parents=True, exist_ok=True)
    if not TOKEN_PATH.exists():
        TOKEN_PATH.write_text(secrets.token_hex(24) + "\n", encoding="utf-8")
        TOKEN_PATH.chmod(0o600)
        print("[zsparx] generated API token at %s" % TOKEN_PATH, flush=True)
    print("[zsparx] listening on port %d" % PORT, flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
