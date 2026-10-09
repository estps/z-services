// Z Admin Console — ops dashboard on port 1937 (access.z-chat.men)
// v1: login via z-chat account (must be admin), service health, deploy log,
// quick restart. No service-role key anywhere: RLS + own token only.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
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

const PORTAL_ORIGIN = process.env.PORTAL_ORIGIN || "https://z-chat.men";
const SELF_ORIGIN = process.env.SELF_ORIGIN || "https://access.z-chat.men";
const OAUTH_REDIRECT = process.env.OAUTH_REDIRECT || `${SELF_ORIGIN}/auth/callback`;
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "z-console";

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
  const data = verify(cookie(req));
  return data && data.kind === "session" ? data : null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || "").trim(), err: (stderr || "").trim() });
    });
  });
}

/* ---------------- Supabase admin session (application form editor) ----------------
   Each signed-in admin's short-lived Supabase access token is kept in memory
   only. Password logins store the token from the token endpoint; the OAuth
   callback receives a fresh access token from the Z Chat consent page. When a
   token expires the API answers 401 { reauth_required } and the UI asks the
   admin to sign in again. All writes still go through Postgres RLS as that
   admin: no service-role key is used anywhere. */
const REST = `${SUPA_URL}/rest/v1`;
const adminTokens = new Map(); // uid -> { token, exp }

function rememberToken(uid, accessToken) {
  if (!uid || !accessToken) return;
  let exp = Date.now() + 3600_000;
  try {
    const part = String(accessToken).split(".")[1] || "";
    const payload = JSON.parse(Buffer.from(part, "base64url").toString());
    if (payload && typeof payload.exp === "number") exp = payload.exp * 1000;
  } catch {
    /* keep the default one-hour TTL */
  }
  adminTokens.set(uid, { token: accessToken, exp });
}

function tokenFor(uid) {
  const entry = adminTokens.get(uid);
  if (!entry) return null;
  if (entry.exp - 30_000 <= Date.now()) {
    adminTokens.delete(uid);
    return null;
  }
  return entry.token;
}

async function supabaseAdmin(sess, path, init = {}) {
  const token = tokenFor(sess.uid);
  if (!token) return { ok: false, status: 401, body: { error: "reauth_required" } };
  const res = await fetch(`${REST}${path}`, {
    ...init,
    headers: {
      apikey: SUPA_ANON,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  let body = null;
  try {
    body = res.status === 204 ? null : await res.json();
  } catch {
    body = null;
  }
  if (res.status === 401) {
    adminTokens.delete(sess.uid);
    return { ok: false, status: 401, body: { error: "reauth_required" } };
  }
  return { ok: res.ok, status: res.status, body };
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

/* ---------------- OAuth: Sign in with Z Chat (same consent flow as Z Games/Z Slides) ---------------- */

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function secureFlag(req) {
  return (req.headers["x-forwarded-proto"] || "") === "https" ? "; Secure" : "";
}

function handleAuthLogin(req, res) {
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const location =
    `${PORTAL_ORIGIN}/oauth/consent` +
    `?client_id=${encodeURIComponent(OAUTH_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}` +
    `&state=${state}` +
    `&code_challenge=${challenge}` +
    `&code_challenge_method=S256` +
    `&approve_url=${encodeURIComponent(`${SELF_ORIGIN}/api/oauth/approve`)}`;
  const secure = secureFlag(req);
  res.writeHead(302, {
    Location: location,
    "Set-Cookie": [
      `zc_state=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secure}`,
      `zc_verifier=${verifier}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secure}`,
    ],
    "Cache-Control": "no-store",
  });
  res.end();
}

async function handleApproveOauth(req, res) {
  const cors = {
    "Access-Control-Allow-Origin": PORTAL_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
  };
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }
    if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" }, cors);
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
    if (!match) return json(res, 401, { error: "missing_token" }, cors);
    let user = null;
    try {
      const r = await fetch(`${SUPA_URL}/auth/v1/user`, {
        headers: { apikey: SUPA_ANON, Authorization: `Bearer ${match[1]}` },
      });
      if (r.ok) {
        const d = await r.json();
        if (d && d.id) user = { id: d.id, email: d.email };
      }
    } catch {
      /* invalid_token below */
    }
    if (!user) return json(res, 401, { error: "invalid_token" }, cors);

    let adminOk = ADMIN_IDS.has(user.id);
    try {
      const r = await fetch(
        `${SUPA_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=is_admin,banned,timeout_until`,
        { headers: { apikey: SUPA_ANON, Authorization: `Bearer ${match[1]}` } },
      );
      if (r.ok) {
        const rows = await r.json();
        const profile = Array.isArray(rows) ? rows[0] : null;
        if (profile?.banned) return json(res, 403, { error: "banned" }, cors);
        if (profile?.timeout_until && Date.parse(profile.timeout_until) > Date.now()) {
          return json(res, 403, { error: "timed_out" }, cors);
        }
        if (profile?.is_admin === true) adminOk = true;
      }
    } catch {
      /* keep ADMIN_IDS fallback */
    }
    if (!adminOk) return json(res, 403, { error: "not_admin" }, cors);

    // Keep this admin's Supabase token (memory only) so the application-form
    // editor can write through RLS with the admin's own session.
    rememberToken(user.id, match[1]);

    const raw = (await readBody(req)) || "{}";
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (!body || typeof body !== "object") return json(res, 400, { error: "bad_request" }, cors);
    const redirectUri = String(body.redirect_uri || "");
    const state = String(body.state || "");
    const challenge = String(body.code_challenge || "");
    if (redirectUri !== OAUTH_REDIRECT) return json(res, 400, { error: "bad_redirect_uri" }, cors);
    if (!challenge || challenge.length > 200) return json(res, 400, { error: "bad_challenge" }, cors);
    const payload = Buffer.from(
      JSON.stringify({
        kind: "code",
        uid: user.id,
        email: user.email,
        ch: challenge,
        exp: Date.now() + 5 * 60_000,
      }),
    ).toString("base64url");
    const code = sign(payload);
    const redirect = `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    return json(res, 200, { redirect }, cors);
  } catch (e) {
    return json(res, 500, { error: "server_error" }, cors);
  }
}

function authFail(res, status, message) {
  const safe = String(message).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title></head><body style="font-family:system-ui;background:#0b0d12;color:#e8eaf0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="max-width:26rem;text-align:center"><h2>Sign-in failed</h2><p style="color:#9aa3b2">${safe}</p><p><a style="color:#7aa2ff" href="/auth/login">Try again</a></p></div></body></html>`,
  );
}

function handleAuthCallback(req, res) {
  const url = new URL(req.url, "http://localhost");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(req);
  if (url.searchParams.get("error")) return authFail(res, 400, "Sign-in was cancelled.");
  if (!code) return authFail(res, 400, "Missing authorization code.");
  if (!state || !cookies.zc_state || state !== cookies.zc_state) {
    return authFail(res, 403, "Invalid state - please try signing in again.");
  }
  if (!cookies.zc_verifier) return authFail(res, 400, "Missing PKCE verifier - please try again.");
  const data = verify(code);
  if (!data || data.kind !== "code") {
    return authFail(res, 400, "This sign-in link is invalid or expired. Please try again.");
  }
  const challenge = crypto.createHash("sha256").update(cookies.zc_verifier).digest("base64url");
  if (!data.ch || data.ch !== challenge) {
    return authFail(res, 403, "Could not verify the sign-in request. Please try again.");
  }
  const payload = Buffer.from(
    JSON.stringify({ kind: "session", uid: data.uid, email: data.email, exp: Date.now() + 12 * 3600_000 }),
  ).toString("base64url");
  const secure = secureFlag(req);
  res.writeHead(302, {
    Location: "/",
    "Set-Cookie": [
      `zc_admin=${sign(payload)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${secure}`,
      `zc_state=; HttpOnly; Path=/; Max-Age=0${secure}`,
      `zc_verifier=; HttpOnly; Path=/; Max-Age=0${secure}`,
    ],
    "Cache-Control": "no-store",
  });
  res.end();
}

/* ---------------- Black box specs & live utilization (GET /api/system) ---------------- */

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function cpuSpec() {
  const text = readText("/proc/cpuinfo");
  const model = (
    (text.match(/^model name\s*:\s*(.+)$/m) || [])[1] ||
    os.cpus()[0]?.model ||
    "unknown"
  ).trim();
  const logical = os.cpus().length || null;
  const physIds = [...text.matchAll(/^physical id\s*:\s*(\d+)/gm)].map((m) => m[1]);
  const coreIds = [...text.matchAll(/^core id\s*:\s*(\d+)/gm)].map((m) => m[1]);
  let physical = null;
  if (physIds.length && physIds.length === coreIds.length) {
    physical = new Set(physIds.map((p, i) => `${p}:${coreIds[i]}`)).size;
  }
  if (!physical) {
    const cores = Number((text.match(/^cpu cores\s*:\s*(\d+)$/m) || [])[1]);
    if (Number.isFinite(cores) && cores > 0) {
      physical = cores * (Math.max(1, new Set(physIds).size));
    }
  }
  return { model, physical_cores: physical, logical_threads: logical };
}

function cpuTimes() {
  const line = readText("/proc/stat").split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  const total = v.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const idle = (v[3] || 0) + (v[4] || 0);
  return { total, idle };
}

async function cpuUtilization() {
  const a = cpuTimes();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const b = cpuTimes();
  if (!a || !b || b.total <= a.total) return null;
  const pct = (1 - (b.idle - a.idle) / (b.total - a.total)) * 100;
  return Math.round(Math.max(0, Math.min(100, pct)) * 10) / 10;
}

function memInfo() {
  const kv = {};
  for (const line of readText("/proc/meminfo").split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kv[m[1]] = Number(m[2]);
  }
  const total = kv.MemTotal || 0;
  const free = kv.MemFree || 0;
  const available = kv.MemAvailable || free;
  const used = Math.max(0, total - available);
  const mb = (kB) => Math.round(kB / 1024);
  return {
    total_mb: mb(total),
    used_mb: mb(used),
    free_mb: mb(free),
    available_mb: mb(available),
    used_pct: total ? Math.round((used / total) * 1000) / 10 : null,
  };
}

function humanKb(kb) {
  if (!Number.isFinite(kb)) return null;
  const gb = kb / (1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;
}

async function diskUsage() {
  const r = await run("df", ["-kP", "/", "/srv"], { timeout: 4000 });
  if (!r.out) return [];
  const rows = [];
  for (const line of r.out.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [filesystem, size, used, avail, capacity, ...mountParts] = parts;
    rows.push({
      mount: mountParts.join(" "),
      filesystem,
      size: humanKb(Number(size)),
      used: humanKb(Number(used)),
      free: humanKb(Number(avail)),
      used_pct: Number(String(capacity).replace("%", "")) || 0,
    });
  }
  return rows;
}

async function gpuInfo() {
  const r = await run(
    "nvidia-smi",
    [
      "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit",
      "--format=csv,noheader,nounits",
    ],
    { timeout: 4000 },
  );
  if (!r.ok && !r.out) {
    return { available: false, gpus: [], error: r.err || "nvidia-smi unavailable" };
  }
  const num = (s) => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
  };
  const gpus = [];
  for (const line of r.out.split("\n")) {
    if (!line.trim()) continue;
    const p = line.split(",").map((s) => s.trim());
    const usedMb = num(p[2]);
    const totalMb = num(p[3]);
    gpus.push({
      name: p[0] || "GPU",
      utilization_pct: num(p[1]),
      memory_used_mb: usedMb,
      memory_total_mb: totalMb,
      memory_pct: usedMb != null && totalMb ? Math.round((usedMb / totalMb) * 1000) / 10 : null,
      temperature_c: num(p[4]),
      power_w: num(p[5]),
      power_limit_w: num(p[6]),
    });
  }
  return { available: gpus.length > 0, gpus };
}

async function topProcesses() {
  const r = await run("ps", ["-eo", "pid,comm,pcpu,pmem", "--sort=-pcpu", "--no-headers"], {
    timeout: 4000,
  });
  if (!r.ok && !r.out) return [];
  const rows = [];
  for (const line of r.out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const name = parts.slice(1, parts.length - 2).join(" ");
    // Skip the probes themselves so they don't top their own list.
    if (name === "nvidia-smi" || pid === process.pid) continue;
    const memPct = parseFloat(parts[parts.length - 1]);
    const cpuPct = parseFloat(parts[parts.length - 2]);
    rows.push({
      pid: Number.isFinite(pid) ? pid : null,
      name,
      cpu_pct: Number.isFinite(cpuPct) ? cpuPct : 0,
      mem_pct: Number.isFinite(memPct) ? memPct : 0,
    });
    if (rows.length >= 5) break;
  }
  return rows;
}

function osPrettyName() {
  const text = readText("/etc/os-release");
  const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text);
  return m ? m[1].trim() : `${os.type()} ${os.release()}`;
}

function virtualization() {
  if (fs.existsSync("/.dockerenv")) return "docker";
  const cgroup = readText("/proc/self/cgroup");
  if (/docker|containerd|kubepods/.test(cgroup)) return "docker";
  if (/lxc/.test(cgroup)) return "lxc";
  if (/^flags\s*:.*\bhypervisor\b/m.test(readText("/proc/cpuinfo"))) return "vm";
  return "bare-metal";
}

async function systemStats() {
  const settle = (p) => p.then((v) => v).catch(() => null);
  const [utilization, disk, gpu, top] = await Promise.all([
    settle(cpuUtilization()),
    settle(diskUsage()).then((v) => v || []),
    settle(gpuInfo()).then((v) => v || { available: false, gpus: [] }),
    settle(topProcesses()).then((v) => v || []),
  ]);
  const spec = cpuSpec();
  const [l1, l5, l15] = os.loadavg().map((v) => Math.round(v * 100) / 100);
  return {
    time: new Date().toISOString(),
    cpu: { ...spec, utilization_pct: utilization, load: { "1": l1, "5": l5, "15": l15 } },
    memory: memInfo(),
    disk,
    gpu,
    system: {
      hostname: os.hostname(),
      os: osPrettyName(),
      kernel: os.release(),
      uptime_seconds: Math.round(os.uptime()),
      virtualization: virtualization(),
    },
    top,
  };
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

    if (req.method === "GET" && p === "/auth/login") return handleAuthLogin(req, res);
    if (p === "/api/oauth/approve") return handleApproveOauth(req, res);
    if (req.method === "GET" && p === "/auth/callback") return handleAuthCallback(req, res);

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
      rememberToken(token.user.id, token.access_token);
      const payload = Buffer.from(
        JSON.stringify({ kind: "session", uid: token.user.id, email, exp: Date.now() + 12 * 3600_000 }),
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
    if (req.method === "GET" && p === "/api/system") {
      const started = Date.now();
      const stats = await systemStats();
      stats.took_ms = Date.now() - started;
      return json(res, 200, stats);
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

    /* -------- Application form editor (writes via the admin's Supabase session) -------- */
    if (req.method === "GET" && p === "/api/applications/form") {
      const r = await supabaseAdmin(
        sess,
        "/application_form?select=id,label,placeholder,sort_order,enabled,updated_at&order=sort_order.asc,created_at.asc",
      );
      return json(res, r.ok ? 200 : r.status, r.ok ? { questions: r.body } : r.body);
    }
    if (req.method === "POST" && p === "/api/applications/form") {
      if (req.headers["x-zc"] !== "console") return json(res, 400, { error: "bad request" });
      let body = null;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        body = null;
      }
      const label = typeof body?.label === "string" ? body.label.trim() : "";
      const placeholder = typeof body?.placeholder === "string" ? body.placeholder.trim() : "";
      if (!label || label.length > 120) {
        return json(res, 400, { error: "label is required (max 120 chars)" });
      }
      if (placeholder.length > 200) {
        return json(res, 400, { error: "placeholder is too long (max 200 chars)" });
      }
      const last = await supabaseAdmin(
        sess,
        "/application_form?select=sort_order&order=sort_order.desc&limit=1",
      );
      if (!last.ok) return json(res, last.status, last.body);
      const max =
        Array.isArray(last.body) && last.body[0] ? Number(last.body[0].sort_order) || 0 : 0;
      const r = await supabaseAdmin(sess, "/application_form", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ label, placeholder, sort_order: max + 1, enabled: true }),
      });
      return json(
        res,
        r.ok ? 200 : r.status,
        r.ok ? { question: Array.isArray(r.body) ? r.body[0] : null } : r.body,
      );
    }
    if (req.method === "PATCH" && p === "/api/applications/form") {
      if (req.headers["x-zc"] !== "console") return json(res, 400, { error: "bad request" });
      let body = null;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        body = null;
      }
      const id = typeof body?.id === "string" ? body.id.trim() : "";
      if (!id) return json(res, 400, { error: "id is required" });
      const patch = { updated_at: new Date().toISOString() };
      if (typeof body.label === "string") {
        const label = body.label.trim();
        if (!label || label.length > 120) return json(res, 400, { error: "label must be 1-120 chars" });
        patch.label = label;
      }
      if (typeof body.placeholder === "string") {
        const placeholder = body.placeholder.trim();
        if (placeholder.length > 200) {
          return json(res, 400, { error: "placeholder is too long (max 200 chars)" });
        }
        patch.placeholder = placeholder;
      }
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (Number.isInteger(body.sort_order)) patch.sort_order = body.sort_order;
      const r = await supabaseAdmin(sess, `/application_form?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) return json(res, r.status, r.body);
      return json(res, 200, { question: Array.isArray(r.body) ? r.body[0] : null });
    }
    if (req.method === "POST" && p === "/api/applications/form/reorder") {
      if (req.headers["x-zc"] !== "console") return json(res, 400, { error: "bad request" });
      let body = null;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        body = null;
      }
      const ids = Array.isArray(body?.ids)
        ? body.ids.filter((id) => typeof id === "string" && id).slice(0, 50)
        : [];
      if (ids.length === 0) return json(res, 400, { error: "ids are required" });
      for (let index = 0; index < ids.length; index += 1) {
        const r = await supabaseAdmin(
          sess,
          `/application_form?id=eq.${encodeURIComponent(ids[index])}`,
          {
            method: "PATCH",
            body: JSON.stringify({ sort_order: index + 1, updated_at: new Date().toISOString() }),
          },
        );
        if (!r.ok) return json(res, r.status, r.body);
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && p === "/api/applications/submissions") {
      const r = await supabaseAdmin(sess, "/rpc/admin_application_submissions", {
        method: "POST",
        body: JSON.stringify({ _limit: 25 }),
      });
      return json(res, r.ok ? 200 : r.status, r.ok ? { submissions: r.body } : r.body);
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
