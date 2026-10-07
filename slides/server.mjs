#!/usr/bin/env node
/* Z Slides - AI presentation maker for the Z Chat ecosystem.

   - OAuth-gated via the custom Z Chat consent flow (no third-party OAuth).
   - DeepSeek generates slide decks (JSON) from a short brief.
   - Every account gets 3 free AI presentations (lifetime).
   - Hard budget cap (default $5/month) tracked from API token usage.
   - Storage: flat JSON files under STATE_DIR (decks/ + usage.json + budget.json).
*/

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 9861);
const SITE_DIR = process.env.SITE_DIR || path.join(__dirname, "site");
const STATE_DIR = process.env.STATE_DIR || "/srv/zslides/state";
const SELF_ORIGIN = (process.env.SELF_ORIGIN || "https://present.z-chat.men").replace(/\/+$/, "");
const PORTAL_ORIGIN = (process.env.PORTAL_ORIGIN || "https://z-chat.men").replace(/\/+$/, "");
const OAUTH_CONSENT_URL = `${PORTAL_ORIGIN}/oauth/consent`;
const OAUTH_REDIRECT = process.env.OAUTH_REDIRECT || `${SELF_ORIGIN}/auth/callback`;
const CLIENT_ID = process.env.OAUTH_CLIENT_ID || "z-slides";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://dwstivxwyqdogzgxnidm.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-flash";
const DEEPSEEK_URL = process.env.DEEPSEEK_URL || "https://api.deepseek.com/chat/completions";

/* Canva Connect (each user connects their own Canva account; the deck is
   exported as PPTX and Canva's URL-import turns it into a real, editable
   Canva presentation). Requires a Canva integration's client credentials. */
const CANVA_CLIENT_ID = process.env.CANVA_CLIENT_ID || "";
const CANVA_CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET || "";
const CANVA_REDIRECT = process.env.CANVA_REDIRECT || `${SELF_ORIGIN}/auth/canva/callback`;
const CANVA_AUTHORIZE_URL = "https://www.canva.com/api/oauth/authorize";
const CANVA_TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";
const CANVA_IMPORTS_URL = "https://api.canva.com/rest/v1/url-imports";
const CANVA_GENERATIONS_URL = "https://api.canva.com/rest/v1/generations";
const CANVA_CAPS_URL = "https://api.canva.com/rest/v1/users/me/capabilities";
const CANVA_SCOPE = "design:content:write";
const EXPORT_TTL_MS = 30 * 60 * 1000;

const FREE_DECKS = Number(process.env.FREE_DECKS || 3);
const MAX_PAGES = Number(process.env.MAX_PAGES || 6);
const MONTHLY_BUDGET_USD = Number(process.env.MONTHLY_BUDGET_USD || 5);
/* deepseek-chat pricing, USD per 1M tokens (approx) */
const COST_IN_PER_M = Number(process.env.COST_IN_PER_M || 0.27);
const COST_OUT_PER_M = Number(process.env.COST_OUT_PER_M || 1.1);

let SESSION_SECRET = process.env.SESSION_SECRET || "";
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("[zslides] SESSION_SECRET missing; using a per-boot random (sessions reset on restart)");
}

const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 2 * 60 * 1000;
const COOKIE_OPTS = "HttpOnly; SameSite=Lax; Path=/";

const b64url = (input) => Buffer.from(input).toString("base64url");

function sign(payload, scope, ttlMs) {
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  const mac = crypto.createHmac("sha256", `${SESSION_SECRET}:${scope}`).update(body).digest("hex");
  return `${body}.${mac}`;
}

function verify(token, scope) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), "hex");
  const want = crypto.createHmac("sha256", `${SESSION_SECRET}:${scope}`).update(body).digest();
  if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof data.exp !== "number" || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key) out[key] = part.slice(idx + 1).trim();
  }
  return out;
}

function send(req, res, status, headers, body) {
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const out = { "X-Content-Type-Options": "nosniff", ...headers };
  if (payload) out["Content-Length"] = payload.length;
  res.writeHead(status, out);
  if (req.method === "HEAD" || !payload) res.end();
  else res.end(payload);
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve) => {
    let data = "";
    let over = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        over = true;
        req.destroy();
      }
    });
    req.on("end", () => resolve(over ? null : data));
    req.on("error", () => resolve(null));
  });
}

function normalizeUser(source) {
  const meta = source.user_metadata || {};
  const email = source.email || "";
  const name = meta.display_name || source.name || (email.includes("@") ? email.split("@")[0] : email);
  const avatar = meta.avatar_url || source.picture || "";
  return { id: source.id || source.sub || "", email, name, avatar };
}

function currentUser(req) {
  return verify(parseCookies(req).zs_session, "session");
}

/* ---------------- storage ---------------- */

async function ensureState() {
  await fs.mkdir(path.join(STATE_DIR, "decks"), { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

const usageFile = () => path.join(STATE_DIR, "usage.json");
const budgetFile = () => path.join(STATE_DIR, "budget.json");
const monthKey = () => new Date().toISOString().slice(0, 7);

async function getUsage(uid) {
  const all = await readJson(usageFile(), {});
  return all[uid] || { total: 0 };
}

async function bumpUsage(uid) {
  const all = await readJson(usageFile(), {});
  const entry = all[uid] || { total: 0 };
  entry.total += 1;
  all[uid] = entry;
  await writeJson(usageFile(), all);
  return entry;
}

async function getBudget() {
  const all = await readJson(budgetFile(), {});
  const month = monthKey();
  return all[month] || { usd: 0, calls: 0, prompt_tokens: 0, completion_tokens: 0 };
}

async function addBudget(usage) {
  const all = await readJson(budgetFile(), {});
  const month = monthKey();
  const entry = all[month] || { usd: 0, calls: 0, prompt_tokens: 0, completion_tokens: 0 };
  const prompt = Number(usage?.prompt_tokens || 0);
  const completion = Number(usage?.completion_tokens || 0);
  entry.prompt_tokens += prompt;
  entry.completion_tokens += completion;
  entry.usd += (prompt / 1e6) * COST_IN_PER_M + (completion / 1e6) * COST_OUT_PER_M;
  entry.calls += 1;
  all[month] = entry;
  await writeJson(budgetFile(), all);
  return entry;
}

async function listDecks(uid) {
  const dir = path.join(STATE_DIR, "decks");
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const decks = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const deck = await readJson(path.join(dir, name), null);
    if (deck && deck.owner === uid) {
      decks.push({
        id: deck.id,
        title: deck.title,
        pages: Array.isArray(deck.slides) ? deck.slides.length : 0,
        invitees: deck.invitees || [],
        createdAt: deck.createdAt,
        canva: deck.canva ? { status: deck.canva.status, editUrl: deck.canva.editUrl || null } : null,
      });
    }
  }
  decks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return decks;
}

/* ---------------- DeepSeek ---------------- */

function buildPrompt(details, pages, invitees) {
  const audience = invitees && invitees.length ? `Intended audience/invitees: ${invitees.join(", ")}.` : "";
  return [
    "You are a senior presentation designer. Create a concise, professional slide deck.",
    `Return STRICT JSON only, no markdown, no code fences, with this exact shape:`,
    `{"title": "Deck title", "slides": [{"title": "Slide title", "bullets": ["point", "point", "point"]}]}`,
    `Rules: exactly ${pages} slides; 3-5 short bullets per slide; no bullet longer than 16 words;`,
    `plain text only; make the content specific to the brief and easy to present live.`,
    audience,
    `Brief: ${details}`,
  ].filter(Boolean).join("\n");
}

async function generateDeck(details, pages, invitees) {
  if (!DEEPSEEK_API_KEY) throw new Error("server is missing its AI key");
  const response = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: "You output only valid JSON. Never wrap it in markdown." },
        { role: "user", content: buildPrompt(details, pages, invitees) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 4000,
      temperature: 0.7,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`AI request failed (${response.status}) ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  const usage = data.usage || {};
  const content = data.choices?.[0]?.message?.content || "";
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || !Array.isArray(parsed.slides) || !parsed.slides.length) {
    throw new Error("AI returned an unexpected format; please try again");
  }
  const slides = parsed.slides
    .slice(0, MAX_PAGES)
    .map((slide) => ({
      title: String(slide.title || "").slice(0, 120) || "Untitled slide",
      bullets: (Array.isArray(slide.bullets) ? slide.bullets : [])
        .slice(0, 6)
        .map((b) => String(b).slice(0, 220)),
    }))
    .filter((slide) => slide.title || slide.bullets.length);
  if (!slides.length) throw new Error("AI returned an empty deck; please try again");
  return {
    title: String(parsed.title || details.slice(0, 80) || "Untitled presentation").slice(0, 140),
    slides,
    usage,
  };
}

/* ---------------- OAuth (custom Z Chat consent flow) ---------------- */

function handleLogin(req, res, url) {
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const location =
    `${OAUTH_CONSENT_URL}` +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}` +
    `&state=${state}` +
    `&code_challenge=${challenge}` +
    `&code_challenge_method=S256` +
    `&approve_url=${encodeURIComponent(`${SELF_ORIGIN}/api/oauth/approve`)}`;
  send(req, res, 302, {
    Location: location,
    "Set-Cookie": [
      `zs_state=${state}; ${COOKIE_OPTS}; Max-Age=600`,
      `zs_verifier=${verifier}; ${COOKIE_OPTS}; Max-Age=600`,
    ],
    "Cache-Control": "no-store",
  }, "");
}

async function handleApprove(req, res) {
  const cors = {
    "Access-Control-Allow-Origin": PORTAL_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
  };
  const json = { ...cors, "Content-Type": "application/json; charset=utf-8" };
  if (req.method === "OPTIONS") return send(req, res, 204, cors);
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!match) return send(req, res, 401, json, JSON.stringify({ error: "missing_token" }));
  let user = null;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${match[1]}` },
    });
    if (response.ok) {
      const data = await response.json();
      if (data && (data.id || data.email)) {
        user = normalizeUser({ id: data.id, email: data.email, user_metadata: data.user_metadata });
      }
    }
  } catch {
    /* invalid_token below */
  }
  if (!user || !user.id) return send(req, res, 401, json, JSON.stringify({ error: "invalid_token" }));
  try {
    const profileResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=banned,timeout_until`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${match[1]}` } }
    );
    if (profileResponse.ok) {
      const rows = await profileResponse.json();
      const profile = Array.isArray(rows) ? rows[0] : null;
      if (profile && profile.banned) return send(req, res, 403, json, JSON.stringify({ error: "banned" }));
      if (profile && profile.timeout_until && Date.parse(profile.timeout_until) > Date.now()) {
        return send(req, res, 403, json, JSON.stringify({ error: "timed_out", until: profile.timeout_until }));
      }
    }
  } catch {
    /* fail open */
  }
  const raw = await readBody(req);
  let body = null;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") return send(req, res, 400, json, JSON.stringify({ error: "bad_request" }));
  const redirectUri = String(body.redirect_uri || "");
  const state = String(body.state || "");
  const challenge = String(body.code_challenge || "");
  if (redirectUri !== OAUTH_REDIRECT) return send(req, res, 400, json, JSON.stringify({ error: "bad_redirect_uri" }));
  if (!challenge || challenge.length > 200) return send(req, res, 400, json, JSON.stringify({ error: "bad_challenge" }));
  const code = sign({ sub: user.id, email: user.email, name: user.name, avatar: user.avatar, challenge }, "code", CODE_TTL_MS);
  const redirect = redirectUri + "?code=" + encodeURIComponent(code) + "&state=" + encodeURIComponent(state);
  send(req, res, 200, json, JSON.stringify({ redirect }));
}

function authFail(req, res, status, message) {
  const safe = String(message).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  send(req, res, status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title></head><body style="font-family:system-ui;background:#0b0d12;color:#e8eaf0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="max-width:26rem;text-align:center"><h2>Sign-in failed</h2><p style="color:#9aa3b2">${safe}</p><p><a style="color:#7aa2ff" href="/auth/login">Try again</a></p></div></body></html>`);
}

function handleCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(req);
  if (url.searchParams.get("error")) return authFail(req, res, 400, "Sign-in was cancelled.");
  if (!code) return authFail(req, res, 400, "Missing authorization code.");
  if (!state || !cookies.zs_state || state !== cookies.zs_state) {
    return authFail(req, res, 403, "Invalid state - please try signing in again.");
  }
  if (!cookies.zs_verifier) return authFail(req, res, 400, "Missing PKCE verifier - please try signing in again.");
  const data = verify(code, "code");
  if (!data) return authFail(req, res, 400, "This sign-in link is invalid or expired. Please try again.");
  const challenge = b64url(crypto.createHash("sha256").update(cookies.zs_verifier).digest());
  if (!data.challenge || data.challenge !== challenge) {
    return authFail(req, res, 403, "Could not verify the sign-in request. Please try again.");
  }
  const user = { id: data.sub, email: data.email, name: data.name, avatar: data.avatar };
  const session = sign(user, "session", SESSION_MAX_AGE * 1000);
  send(req, res, 302, {
    Location: "/",
    "Set-Cookie": [
      `zs_session=${session}; ${COOKIE_OPTS}; Max-Age=${SESSION_MAX_AGE}`,
      `zs_state=; ${COOKIE_OPTS}; Max-Age=0`,
      `zs_verifier=; ${COOKIE_OPTS}; Max-Age=0`,
    ],
    "Cache-Control": "no-store",
  }, "");
}

/* ---------------- Canva Connect ---------------- */

const canvaDir = () => path.join(STATE_DIR, "canva");
const canvaFile = (uid) => path.join(canvaDir(), `${uid}.json`);

async function getCanvaTokens(uid) {
  return readJson(canvaFile(uid), null);
}

async function canvaAccessToken(uid) {
  const tokens = await getCanvaTokens(uid);
  if (!tokens || !tokens.refresh_token) return null;
  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000) {
    return tokens.access_token;
  }
  if (!CANVA_CLIENT_ID || !CANVA_CLIENT_SECRET) return null;
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  const response = await fetch(CANVA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${CANVA_CLIENT_ID}:${CANVA_CLIENT_SECRET}`).toString("base64"),
    },
    body,
  });
  if (!response.ok) return null;
  const data = await response.json();
  tokens.access_token = data.access_token;
  if (data.refresh_token) tokens.refresh_token = data.refresh_token;
  tokens.expires_at = Date.now() + Number(data.expires_in || 14400) * 1000;
  await writeJson(canvaFile(uid), tokens);
  return tokens.access_token;
}

async function buildPptx(deck) {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "Z16x9", width: 13.333, height: 7.5 });
  pptx.layout = "Z16x9";
  const title = pptx.addSlide();
  title.background = { color: "6D5CFF" };
  title.addText(deck.title, { x: 0.9, y: 2.6, w: 11.5, h: 1.7, fontSize: 42, bold: true, color: "FFFFFF" });
  title.addText("Created with Z Slides", { x: 0.9, y: 4.5, w: 11.5, h: 0.6, fontSize: 15, color: "E8E6FF" });
  for (const slide of deck.slides) {
    const s = pptx.addSlide();
    s.background = { color: "0E1118" };
    s.addShape("rect", { x: 0, y: 0, w: 0.22, h: 7.5, fill: { color: "6D5CFF" } });
    s.addText(slide.title, { x: 0.9, y: 0.65, w: 11.7, h: 1.2, fontSize: 32, bold: true, color: "FFFFFF" });
    s.addText(
      (slide.bullets || []).map((b) => ({ text: b, options: { bullet: { code: "25CF" }, breakLine: true } })),
      { x: 0.95, y: 2.0, w: 11.6, h: 4.9, fontSize: 19, color: "CBD3E1", lineSpacingMultiple: 1.35 }
    );
  }
  return await pptx.write({ outputType: "nodebuffer" });
}

function exportUrl(deckId) {
  const exp = Date.now() + EXPORT_TTL_MS;
  const mac = crypto.createHmac("sha256", `${SESSION_SECRET}:export`).update(`${deckId}.${exp}`).digest("hex").slice(0, 32);
  return `${SELF_ORIGIN}/pub/${deckId}.${exp}.${mac}.pptx`;
}

function validExport(id, exp, mac) {
  const want = crypto.createHmac("sha256", `${SESSION_SECRET}:export`).update(`${id}.${exp}`).digest("hex").slice(0, 32);
  return Date.now() <= Number(exp) && mac === want;
}

async function getExportBuffer(deck, id) {
  const file = path.join(STATE_DIR, "exports", `${id}.pptx`);
  try {
    return await fs.readFile(file);
  } catch {
    const buffer = await buildPptx(deck);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buffer);
    return buffer;
  }
}

async function startCanvaImport(deck, uid) {
  const token = await canvaAccessToken(uid);
  if (!token) return null;
  await getExportBuffer(deck, deck.id);
  const response = await fetch(CANVA_IMPORTS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: exportUrl(deck.id), title: deck.title }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("[zslides] canva import start failed:", response.status, JSON.stringify(data).slice(0, 300));
    return null;
  }
  return { kind: "import", jobId: data.job?.id || null, status: data.job?.status || "in_progress" };
}

function hasGenerationCapability(payload) {
  const list = payload && Array.isArray(payload.capabilities) ? payload.capabilities : [];
  return list.some((entry) => {
    if (typeof entry === "string") return entry === "design_generation";
    if (entry && typeof entry === "object") {
      const name = entry.name || entry.type || entry.capability || entry.id;
      if (name !== "design_generation") return false;
      return entry.available !== false;
    }
    return false;
  });
}

/* Prefer Canva's native design generation (the user's Canva AI builds the
   presentation from our outline, fully native + editable). Falls back to
   importing our PPTX export when the capability or credits aren't available. */
async function startCanvaDesign(deck, uid) {
  const token = await canvaAccessToken(uid);
  if (!token) return null;
  let generationAvailable = false;
  try {
    const capsResponse = await fetch(CANVA_CAPS_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (capsResponse.ok) {
      generationAvailable = hasGenerationCapability(await capsResponse.json().catch(() => null));
    }
  } catch {
    /* fall back to import */
  }
  if (generationAvailable) {
    const sections = deck.slides.map((slide) => {
      const bullets = Array.isArray(slide.bullets) ? slide.bullets : [];
      const description = (bullets.join(". ") || slide.title || "Slide").slice(0, 2000);
      return {
        title: String(slide.title || "Untitled").slice(0, 255) || "Untitled",
        description: description || "Slide",
        points: bullets.map((b) => String(b).slice(0, 1000)).slice(0, 50),
      };
    });
    const brief = `${deck.title}. ${deck.details}`.slice(0, 5000);
    try {
      const response = await fetch(CANVA_GENERATIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          brief,
          design_type: { type: "preset", name: "presentation" },
          outline: { sections },
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        return { kind: "generation", jobId: data.job?.id || null, status: data.job?.status || "in_progress" };
      }
      console.error("[zslides] canva native generation unavailable:", response.status, JSON.stringify(data).slice(0, 200));
    } catch (err) {
      console.error("[zslides] canva native generation failed:", err);
    }
  }
  return startCanvaImport(deck, uid);
}

/* ---------------- Canva OAuth routes ---------------- */

function handleCanvaLogin(req, res) {
  if (!CANVA_CLIENT_ID || !CANVA_CLIENT_SECRET) {
    return authFail(req, res, 400, "Canva is not configured yet on this server.");
  }
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const location =
    `${CANVA_AUTHORIZE_URL}` +
    `?code_challenge_method=s256` +
    `&response_type=code` +
    `&client_id=${encodeURIComponent(CANVA_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(CANVA_REDIRECT)}` +
    `&scope=${encodeURIComponent(CANVA_SCOPE)}` +
    `&state=${state}` +
    `&code_challenge=${challenge}`;
  send(req, res, 302, {
    Location: location,
    "Set-Cookie": [
      `cs_state=${state}; ${COOKIE_OPTS}; Max-Age=600`,
      `cs_verifier=${verifier}; ${COOKIE_OPTS}; Max-Age=600`,
    ],
    "Cache-Control": "no-store",
  }, "");
}

async function handleCanvaCallback(req, res, url) {
  const user = currentUser(req);
  if (!user) return send(req, res, 302, { Location: "/auth/login", "Cache-Control": "no-store" }, "");
  const clearCookies = [`cs_state=; ${COOKIE_OPTS}; Max-Age=0`, `cs_verifier=; ${COOKIE_OPTS}; Max-Age=0`];
  if (url.searchParams.get("error")) {
    return send(req, res, 302, { Location: "/?canva=denied", "Set-Cookie": clearCookies, "Cache-Control": "no-store" }, "");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(req);
  if (!code || !state || !cookies.cs_state || state !== cookies.cs_state || !cookies.cs_verifier) {
    return send(req, res, 302, { Location: "/?canva=error", "Set-Cookie": clearCookies, "Cache-Control": "no-store" }, "");
  }
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: cookies.cs_verifier,
      redirect_uri: CANVA_REDIRECT,
    });
    const response = await fetch(CANVA_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${CANVA_CLIENT_ID}:${CANVA_CLIENT_SECRET}`).toString("base64"),
      },
      body,
    });
    if (!response.ok) throw new Error(`token exchange ${response.status}`);
    const data = await response.json();
    if (!data.refresh_token) throw new Error("no refresh token in response");
    await writeJson(canvaFile(user.id), {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + Number(data.expires_in || 14400) * 1000,
    });
    send(req, res, 302, { Location: "/?canva=connected", "Set-Cookie": clearCookies, "Cache-Control": "no-store" }, "");
  } catch (err) {
    console.error("[zslides] canva token exchange failed:", err);
    send(req, res, 302, { Location: "/?canva=error", "Set-Cookie": clearCookies, "Cache-Control": "no-store" }, "");
  }
}

/* ---------------- app API ---------------- */

async function handleGenerate(req, res, user) {
  if (!DEEPSEEK_API_KEY) {
    return send(req, res, 500, { "Content-Type": "application/json" }, JSON.stringify({ error: "no_ai_key", message: "The AI key is not configured yet." }));
  }
  const raw = await readBody(req);
  let body = null;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") {
    return send(req, res, 400, { "Content-Type": "application/json" }, JSON.stringify({ error: "bad_request" }));
  }
  const details = String(body.details || "").trim();
  const pages = Math.max(1, Math.min(MAX_PAGES, Number(body.pages) || 6));
  const invitees = (Array.isArray(body.invitees) ? body.invitees : String(body.invitees || "").split(","))
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .slice(0, 20);
  if (details.length < 10) {
    return send(req, res, 400, { "Content-Type": "application/json" }, JSON.stringify({ error: "details_too_short", message: "Tell the AI a bit more about the presentation." }));
  }
  if (details.length > 2000) {
    return send(req, res, 400, { "Content-Type": "application/json" }, JSON.stringify({ error: "details_too_long" }));
  }
  const usage = await getUsage(user.id);
  if (usage.total >= FREE_DECKS) {
    return send(req, res, 402, { "Content-Type": "application/json" }, JSON.stringify({ error: "quota", message: `You have used all ${FREE_DECKS} free presentations.` }));
  }
  const budget = await getBudget();
  if (budget.usd >= MONTHLY_BUDGET_USD) {
    return send(req, res, 503, { "Content-Type": "application/json" }, JSON.stringify({ error: "budget", message: "This month's AI budget is used up. Try again next month." }));
  }

  let generated;
  try {
    generated = await generateDeck(details, pages, invitees);
  } catch (err) {
    console.error("[zslides] generation failed:", err);
    return send(req, res, 502, { "Content-Type": "application/json" }, JSON.stringify({ error: "ai_failed", message: String(err.message || err) }));
  }
  await addBudget(generated.usage);
  await bumpUsage(user.id);

  const id = crypto.randomBytes(8).toString("hex");
  const deck = {
    id,
    owner: user.id,
    ownerName: user.name,
    title: generated.title,
    details,
    invitees,
    slides: generated.slides,
    createdAt: new Date().toISOString(),
  };
  const deckPath = path.join(STATE_DIR, "decks", `${id}.json`);
  await writeJson(deckPath, deck);
  /* If the user connected Canva, push the deck straight into their account. */
  try {
    const canva = await startCanvaDesign(deck, user.id);
    if (canva) {
      deck.canva = canva;
      await writeJson(deckPath, deck);
    }
  } catch (err) {
    console.error("[zslides] canva start failed:", err);
  }
  send(req, res, 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, JSON.stringify({ deck }));
}

async function handleCanvaStatusApi(req, res, user) {
  const tokens = await getCanvaTokens(user.id);
  send(req, res, 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    JSON.stringify({
      configured: Boolean(CANVA_CLIENT_ID && CANVA_CLIENT_SECRET),
      connected: Boolean(tokens && tokens.refresh_token),
    }));
}

async function handleDeckCanva(req, res, user, id) {
  const deckPath = path.join(STATE_DIR, "decks", `${id}.json`);
  const deck = await readJson(deckPath, null);
  if (!deck || deck.owner !== user.id) {
    return send(req, res, 404, { "Content-Type": "application/json" }, JSON.stringify({ error: "not_found" }));
  }
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (!deck.canva || !deck.canva.jobId) {
    return send(req, res, 200, headers, JSON.stringify({ status: "not_started" }));
  }
  if (deck.canva.status === "in_progress") {
    try {
      const token = await canvaAccessToken(user.id);
      if (token) {
        const isGeneration = deck.canva.kind === "generation";
        const pollUrl = isGeneration
          ? `${CANVA_GENERATIONS_URL}/${deck.canva.jobId}`
          : `${CANVA_IMPORTS_URL}/${deck.canva.jobId}`;
        const response = await fetch(pollUrl, { headers: { Authorization: `Bearer ${token}` } });
        const data = await response.json().catch(() => ({}));
        const job = data.job || {};
        if (job.status === "success") {
          const design = isGeneration
            ? (job.result && job.result.design) || null
            : (job.result && job.result.designs && job.result.designs[0]) || null;
          deck.canva.status = "success";
          deck.canva.editUrl = (design && design.urls && design.urls.edit_url) || null;
          deck.canva.viewUrl = (design && design.urls && design.urls.view_url) || null;
          await writeJson(deckPath, deck);
        } else if (job.status === "failed") {
          deck.canva.status = "failed";
          deck.canva.error = (job.error && job.error.code) || "generation_failed";
          await writeJson(deckPath, deck);
        }
      }
    } catch (err) {
      console.error("[zslides] canva poll failed:", err);
    }
  }
  send(req, res, 200, headers, JSON.stringify({
    status: deck.canva.status,
    editUrl: deck.canva.editUrl || null,
    viewUrl: deck.canva.viewUrl || null,
    error: deck.canva.error || null,
  }));
}

async function handleDeck(req, res, user, id) {
  const deck = await readJson(path.join(STATE_DIR, "decks", `${id}.json`), null);
  if (!deck || deck.owner !== user.id) {
    return send(req, res, 404, { "Content-Type": "application/json" }, JSON.stringify({ error: "not_found" }));
  }
  send(req, res, 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, JSON.stringify({ deck }));
}

/* ---------------- static + router ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(SITE_DIR, rel);
  if (!target.startsWith(path.resolve(SITE_DIR))) return send(req, res, 403, {}, "Forbidden");
  try {
    const data = await fs.readFile(target);
    send(req, res, 200, {
      "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    }, data);
  } catch {
    send(req, res, 404, { "Content-Type": "text/plain" }, "Not found");
  }
}

async function route(req, res) {
  const method = req.method || "GET";
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return send(req, res, 400, {}, "Bad request");
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(req, res, 400, {}, "Bad request");
  }

  if (pathname === "/healthz") {
    return send(req, res, 200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }, "ok");
  }
  if (pathname === "/auth/login") return handleLogin(req, res, url);
  if (pathname === "/auth/callback") return handleCallback(req, res, url);
  if (pathname === "/api/oauth/approve") return handleApprove(req, res);
  if (pathname === "/auth/canva") return handleCanvaLogin(req, res);
  if (pathname === "/auth/canva/callback") return handleCanvaCallback(req, res, url);

  /* Signed public export URLs (used by Canva's URL import fetcher). */
  const pubMatch = /^\/pub\/([a-f0-9]{8,32})\.(\d{10,17})\.([a-f0-9]{32})\.pptx$/.exec(pathname);
  if (pubMatch && (method === "GET" || method === "HEAD")) {
    const [, id, exp, mac] = pubMatch;
    if (!validExport(id, exp, mac)) return send(req, res, 403, {}, "Forbidden");
    const deck = await readJson(path.join(STATE_DIR, "decks", `${id}.json`), null);
    if (!deck) return send(req, res, 404, {}, "Not found");
    const buffer = await getExportBuffer(deck, id);
    return send(req, res, 200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Cache-Control": "private, max-age=600",
    }, buffer);
  }

  const user = currentUser(req);
  if (!user) {
    if (pathname.startsWith("/api/")) {
      return send(req, res, 401, { "Content-Type": "application/json" }, JSON.stringify({ error: "unauthorized" }));
    }
    return send(req, res, 302, { Location: "/auth/login", "Cache-Control": "no-store" }, "");
  }

  if (pathname === "/auth/logout") {
    return send(req, res, 302, { Location: "/auth/login", "Set-Cookie": `zs_session=; ${COOKIE_OPTS}; Max-Age=0`, "Cache-Control": "no-store" }, "");
  }
  if (pathname === "/api/me") {
    const usage = await getUsage(user.id);
    const budget = await getBudget();
    return send(req, res, 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      JSON.stringify({
        user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar },
        usage: { used: usage.total, free: FREE_DECKS, left: Math.max(0, FREE_DECKS - usage.total) },
        budgetCap: MONTHLY_BUDGET_USD,
      }));
  }
  if (pathname === "/api/decks" && (method === "GET" || method === "HEAD")) {
    const decks = await listDecks(user.id);
    return send(req, res, 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, JSON.stringify({ decks }));
  }
  if (pathname === "/api/canva/status") {
    return handleCanvaStatusApi(req, res, user);
  }
  const canvaMatch = /^\/api\/decks\/([a-f0-9]{8,32})\/canva$/.exec(pathname);
  if (canvaMatch) {
    return handleDeckCanva(req, res, user, canvaMatch[1]);
  }
  if (pathname === "/api/generate" && method === "POST") {
    return handleGenerate(req, res, user);
  }
  const deckMatch = /^\/api\/decks\/([a-f0-9]{8,32})$/.exec(pathname);
  if (deckMatch) {
    return handleDeck(req, res, user, deckMatch[1]);
  }

  if (method === "GET" || method === "HEAD") {
    return serveStatic(req, res, pathname);
  }
  send(req, res, 405, { Allow: "GET, HEAD, POST" }, "Method not allowed");
}

await ensureState().catch((err) => {
  console.error("[zslides] cannot create state dir:", err);
  process.exit(1);
});

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error("[zslides] request failed:", err);
    if (res.headersSent) return res.destroy();
    try {
      send(req, res, 500, { "Content-Type": "text/plain" }, "Internal server error");
    } catch {
      res.destroy();
    }
  });
});

server.listen(PORT, () => {
  console.log(`[zslides] listening on :${PORT} (self=${SELF_ORIGIN}, state=${STATE_DIR}, model=${DEEPSEEK_MODEL})`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
