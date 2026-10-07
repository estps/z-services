#!/usr/bin/env node
/* zmedia - Z Chat media storage on the black box.

   Replaces Supabase Storage (free plan is only 1 GB): avatars and chat
   images are written to the box filesystem and served back over
   https://z-chat.men/media/* via a Cloudflare tunnel path rule.

   Routes:
     POST /media/api/upload?bucket=avatars|chat-media
          Authorization: Bearer <supabase access token>
          X-File-Path: <validated relative path>
          raw image bytes as the body (max 50 MB)
          -> {"path": "bb:<bucket>/<path>"}
     GET /media/<bucket>/<path>   (immutable, uuid-based names)
     GET /healthz
*/

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.env.ZMEDIA_PORT || 8801);
const UPLOAD_ROOT = process.env.ZMEDIA_ROOT || "/srv/zchat/uploads";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://dwstivxwyqdogzgxnidm.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const BUCKETS = new Set(["avatars", "chat-media"]);
const SAFE_PATH = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const ALLOWED_TYPES = new Set(Object.values(MIME));

function send(res, status, headers, body) {
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const out = { "X-Content-Type-Options": "nosniff", ...headers };
  if (payload) out["Content-Length"] = payload.length;
  res.writeHead(status, out);
  res.end(payload);
}

function sanitizePath(raw) {
  if (!raw || typeof raw !== "string" || raw.length > 300) return null;
  const cleaned = raw.replace(/^\/+/, "");
  if (!SAFE_PATH.test(cleaned)) return null;
  if (cleaned.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  return cleaned;
}

async function requireUser(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!match) return null;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${match[1]}` },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.id ? { id: data.id, token: match[1] } : null;
  } catch {
    return null;
  }
}

async function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let over = false;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        over = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

async function handleUpload(req, res, url) {
  const bucket = String(url.searchParams.get("bucket") || "");
  if (!BUCKETS.has(bucket)) {
    return send(res, 400, { "Content-Type": "application/json" }, JSON.stringify({ message: "Unknown bucket" }));
  }
  const user = await requireUser(req);
  if (!user) {
    return send(res, 401, { "Content-Type": "application/json" }, JSON.stringify({ message: "Sign in again to upload" }));
  }
  const rel = sanitizePath(String(req.headers["x-file-path"] || ""));
  if (!rel) {
    return send(res, 400, { "Content-Type": "application/json" }, JSON.stringify({ message: "Invalid file path" }));
  }
  const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.has(contentType)) {
    return send(res, 415, { "Content-Type": "application/json" }, JSON.stringify({ message: "Only images are allowed" }));
  }

  const data = await readBody(req, MAX_UPLOAD_BYTES);
  if (!data) {
    return send(res, 413, { "Content-Type": "application/json" }, JSON.stringify({ message: "File too large (max 50 MB)" }));
  }
  if (!data.length) {
    return send(res, 400, { "Content-Type": "application/json" }, JSON.stringify({ message: "Empty upload" }));
  }

  /* Monthly quota: 2 GB per rolling 30 days (tracked in Supabase). */
  try {
    const quotaResponse = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upload_quota_left`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (quotaResponse.ok) {
      const left = Number(await quotaResponse.json());
      if (Number.isFinite(left) && data.length > left) {
        return send(res, 413, { "Content-Type": "application/json" }, JSON.stringify({ message: "You have reached your 2 GB monthly upload limit" }));
      }
    }
  } catch {
    /* quota check is best-effort; never block uploads on it */
  }

  const dest = path.join(UPLOAD_ROOT, bucket, rel);
  const root = path.resolve(UPLOAD_ROOT, bucket);
  if (!path.resolve(dest).startsWith(root + path.sep)) {
    return send(res, 400, { "Content-Type": "application/json" }, JSON.stringify({ message: "Invalid file path" }));
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, data);

  /* Record usage for the monthly quota. */
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/upload_log`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${user.token}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: user.id, bytes: data.length }),
    });
  } catch {
    /* non-fatal */
  }

  return send(res, 200, { "Content-Type": "application/json" }, JSON.stringify({ path: `bb:${bucket}/${rel}` }));
}

async function serveFile(req, res, pathname) {
  const rel = pathname.slice("/media/".length);
  if (!rel) return send(res, 404, { "Content-Type": "text/plain" }, "Not found");
  const dest = path.resolve(UPLOAD_ROOT, rel);
  const root = path.resolve(UPLOAD_ROOT);
  if (!dest.startsWith(root + path.sep)) {
    return send(res, 403, { "Content-Type": "text/plain" }, "Forbidden");
  }
  try {
    const stat = await fs.stat(dest);
    if (!stat.isFile()) throw new Error("not a file");
    const data = await fs.readFile(dest);
    send(res, 200, {
      "Content-Type": MIME[path.extname(dest).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    }, data);
  } catch {
    send(res, 404, { "Content-Type": "text/plain" }, "Not found");
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  void (async () => {
    if (pathname === "/healthz") return send(res, 200, { "Content-Type": "text/plain" }, "ok");
    if (pathname === "/media/api/upload" && req.method === "POST") return handleUpload(req, res, url);
    if (pathname.startsWith("/media/") && (req.method === "GET" || req.method === "HEAD")) {
      return serveFile(req, res, pathname);
    }
    send(res, 404, { "Content-Type": "text/plain" }, "Not found");
  })().catch((err) => {
    console.error("[zmedia] request failed:", err);
    if (!res.headersSent) send(res, 500, { "Content-Type": "text/plain" }, "Internal error");
    else res.destroy();
  });
});

await fs.mkdir(path.join(UPLOAD_ROOT, "avatars"), { recursive: true });
await fs.mkdir(path.join(UPLOAD_ROOT, "chat-media"), { recursive: true });

server.listen(PORT, () => {
  console.log(`[zmedia] listening on :${PORT} (root=${UPLOAD_ROOT})`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
