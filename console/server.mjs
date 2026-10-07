// Z Admin Console — ops dashboard on port 1937 (access.z-chat.men)
// v1: login via z-chat account (must be admin), service health, deploy log,
// quick restart. No service-role key anywhere: RLS + own token only.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 1937);
const SUPA_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPA_ANON = process.env.SUPABASE_ANON_KEY || "";
const SECRET = process.env.SESSION_SECRET || "";
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
);
const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");
const DEPLOY_LOG = "/srv/zchat/deploy.log";

const UNITS = [
  "zchat-app",
  "zchat-build",
  "zchat-deploy.timer",
  "zslides",
  "zbox-mcp",
  "zmedia",
  "zgames",
  "zgames-heal.timer",
  "ollama",
];

if (!SUPA_URL || !SUPA_ANON || !SECRET) {
  console.error("missing env: SUPABASE_URL / SUPABASE_ANON_KEY / SESSION_SECRET");
  process.exit(1);
}

function sign(payload) {
  const mac = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}
function verify(token) {
  if (!token || !token.includes(".")) return null;
  const idx = token.lastIndexOf(".");
  const payload = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expect = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  if (mac.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}
function cookie(req) {
  const raw = req.headers.cookie || "";
  const part = raw.split(";").map((s) => s.trim()).find((s) => s.startsWith("zc_admin="));
  return part ? part.slice("zc_admin=".length) : null;
}
function session(req) {
  return verify(cookie(req));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || "").trim(), err: (stderr || "").trim() });
    });
  });
}

const loginHits = [];
function rateLimited() {
  const now = Date.now();
  while (loginHits.length && now - loginHits[0] > 60_000) loginHits.shift();
  if (loginHits.length >= 6) return true;
  loginHits.push(now);
  return false;
}

function json(res, code, body, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) reject(new Error("too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function supabaseLogin(email, password) {
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPA_ANON },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return null;
  return res.json();
}
async function supabaseProfile(accessToken, userId) {
  const res = await fetch(
    `${SUPA_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=is_admin,banned,display_name,username`,
    { headers: { apikey: SUPA_ANON, Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows?.[0] ?? null;
}

async function health() {
  const services = [];
  for (const unit of UNITS) {
    const active = await run("systemctl", ["is-active", unit]);
    services.push({ unit, active: active.out || "unknown" });
  }
  const mem = await run("free", ["-m"]);
  const disk = await run("df", ["-h", "/", "/srv"]);
  const uptime = await run("uptime", []);
  const frozen = await run("wc", ["-l", "/srv/zgames/state/frozen.jsonl"]);
  return {
    services,
    mem: mem.out,
    disk: disk.out,
    uptime: uptime.out,
    frozenCount: frozen.ok ? frozen.out : "n/a",
    time: new Date().toISOString(),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      const html = fs.readFileSync(path.join(SITE, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    }

    if (req.method === "POST" && p === "/api/login") {
      const csrf = req.headers["x-zc"];
      if (csrf !== "console") return json(res, 400, { error: "bad request" });
      if (rateLimited()) return json(res, 429, { error: "Too many attempts, wait a minute." });
      const body = JSON.parse((await readBody(req)) || "{}");
      const email = String(body.email || "").trim();
      const password = String(body.password || "");
      if (!email || !password) return json(res, 400, { error: "email and password required" });
      const token = await supabaseLogin(email, password);
      if (!token?.access_token || !token?.user?.id) return json(res, 401, { error: "Invalid login" });
      const profile = await supabaseProfile(token.access_token, token.user.id);
      const isAdmin = profile?.is_admin === true || ADMIN_IDS.has(token.user.id);
      if (!isAdmin) return json(res, 403, { error: "Not an admin account" });
      const payload = Buffer.from(
        JSON.stringify({ uid: token.user.id, email, exp: Date.now() + 12 * 3600_000 }),
      ).toString("base64url");
      const secure = (req.headers["x-forwarded-proto"] || "") === "https" ? "; Secure" : "";
      return json(
        res,
        200,
        { ok: true, email, display_name: profile?.display_name },
        { "Set-Cookie": `zc_admin=${sign(payload)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${secure}` },
      );
    }

    const sess = session(req);
    if (p === "/api/me") return json(res, 200, { admin: !!sess, email: sess?.email ?? null });
    if (req.method === "POST" && p === "/api/logout") {
      return json(res, 200, { ok: true }, { "Set-Cookie": "zc_admin=; HttpOnly; Path=/; Max-Age=0" });
    }
    if (!sess) return json(res, 401, { error: "login required" });

    if (req.method === "GET" && p === "/api/health") {
      return json(res, 200, await health());
    }
    if (req.method === "GET" && p === "/api/deploy") {
      let lines = [];
      try {
        lines = fs.readFileSync(DEPLOY_LOG, "utf8").split("\n").slice(-40);
      } catch (e) {
        lines = [`deploy.log not readable: ${e.message}`];
      }
      return json(res, 200, { lines });
    }
    if (req.method === "POST" && p === "/api/restart") {
      if (req.headers["x-zc"] !== "console") return json(res, 400, { error: "bad request" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const allowed = { zchat: "zchat-app", zslides: "zslides", zbox: "zbox-mcp", zmedia: "zmedia" };
      const unit = allowed[String(body.target || "")];
      if (!unit) return json(res, 400, { error: "unknown target" });
      const r = await run("sudo", ["-n", "systemctl", "restart", unit]);
      return json(res, r.ok ? 200 : 500, { ok: r.ok, out: r.out, err: r.err });
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 500, { error: e instanceof Error ? e.message : "server error" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`zconsole on http://127.0.0.1:${PORT}`);
});
