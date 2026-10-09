/* Z Slides - free web research + image sourcing.

   Everything here uses only free, unauthenticated sources:
     - DuckDuckGo HTML endpoint for web results (html.duckduckgo.com/html/)
     - DuckDuckGo image search (search page -> vqd -> i.js JSON)
     - Bing Images HTML scrape as fallback (murl extraction)
     - Direct page fetches for research text

   Design rules: all network calls are timeout guarded, response bodies are
   byte-capped, images are size-capped and magic-byte validated, and every
   failure degrades to "no result" instead of throwing into generation. */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const STOPWORDS = new Set(
  "the and for with that this from your you are was were will would can could should about into over under them they their there here what when where which while who whom whose how why not but all any each more most other some such only own same than too very just also our out its it's its's".split(/\s+/)
);

/* ---------------- small utilities ---------------- */

export function decodeEntities(input) {
  return String(input || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 16));
      } catch {
        return m;
      }
    })
    .replace(/&#(\d+);/g, (m, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return m;
      }
    });
}

export function stripHtml(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<(script|style|noscript|svg|head|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
  )
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function safeHttpUrl(raw, base) {
  try {
    const url = new URL(String(raw), base || undefined);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (isPrivateHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

async function fetchCapped(url, { timeoutMs = 6000, byteCap = 300 * 1024, headers = {}, accept = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...headers },
    });
    if (!response.ok || !response.body) return { response, text: "" };
    const type = String(response.headers.get("content-type") || "");
    if (accept && !accept.some((part) => type.includes(part))) return { response, text: "" };
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > byteCap) {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
        return { response, text: "", overflow: true };
      }
      chunks.push(value);
    }
    return { response, text: Buffer.concat(chunks).toString("utf8") };
  } catch {
    return { response: null, text: "" };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- DuckDuckGo web search ---------------- */

function ddgRealUrl(href) {
  const raw = decodeEntities(href);
  try {
    const url = raw.startsWith("//") ? new URL(`https:${raw}`) : new URL(raw, "https://duckduckgo.com/");
    const uddg = url.searchParams.get("uddg");
    if (uddg) return safeHttpUrl(uddg)?.toString() || null;
    if (url.hostname.endsWith("duckduckgo.com")) return null;
    return safeHttpUrl(url)?.toString() || null;
  } catch {
    return null;
  }
}

export async function ddgSearch(query, { limit = 5, timeoutMs = 6000 } = {}) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`;
  const { text } = await fetchCapped(url, { timeoutMs, byteCap: 400 * 1024, accept: ["text/html", "text/plain"] });
  if (!text) return [];
  const results = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(text))) snippets.push(stripHtml(sm[1]).slice(0, 400));
  let lm;
  let i = 0;
  while ((lm = linkRe.exec(text)) && results.length < limit) {
    const target = ddgRealUrl(lm[1]);
    if (!target) continue;
    const title = stripHtml(lm[2]).slice(0, 160);
    if (!title) continue;
    results.push({ url: target, title, snippet: snippets[i] || "" });
    i += 1;
  }
  return results;
}

/* ---------------- page text + fact extraction ---------------- */

export async function fetchPageText(url, { timeoutMs = 5000, byteCap = 280 * 1024 } = {}) {
  const target = safeHttpUrl(url);
  if (!target) return "";
  const { text } = await fetchCapped(target.toString(), {
    timeoutMs,
    byteCap,
    accept: ["text/html", "text/plain", "application/xhtml"],
  });
  if (!text) return "";
  return stripHtml(text).slice(0, 24000);
}

function sentencesOf(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 40 && s.length <= 320);
}

function queryTerms(query) {
  return [...new Set(String(query || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [])].filter((t) => !STOPWORDS.has(t));
}

const BOILERPLATE = /(learn more|read more|sign up|subscribe|cookie|all rights reserved|terms of (use|service)|privacy policy|click here|follow us|share this|advertisement)/i;

export function pickFacts(query, pages, { maxFacts = 9, maxChars = 3000 } = {}) {
  const terms = queryTerms(query);
  const scored = [];
  const seen = new Set();
  for (const page of pages) {
    for (const sentence of sentencesOf(page)) {
      const key = sentence.toLowerCase().slice(0, 70);
      if (seen.has(key)) continue;
      seen.add(key);
      if (BOILERPLATE.test(sentence)) continue;
      const lower = sentence.toLowerCase();
      let score = 0;
      for (const term of terms) if (lower.includes(term)) score += 1;
      if (/\d/.test(sentence)) score += 0.75;
      if (sentence.length > 80 && sentence.length < 240) score += 0.25;
      if (score <= 0) continue;
      scored.push({ sentence, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const facts = [];
  let chars = 0;
  for (const entry of scored) {
    if (facts.length >= maxFacts || chars + entry.sentence.length > maxChars) break;
    facts.push(entry.sentence);
    chars += entry.sentence.length;
  }
  return facts;
}

/* ---------------- topic research (session + disk cached) ---------------- */

const researchMemory = new Map();

export async function researchTopic(details, { stateDir = null, ttlMs = 24 * 60 * 60 * 1000, timeoutMs = 9000 } = {}) {
  const query = String(details || "").trim().slice(0, 200);
  if (query.length < 8) return { facts: [], sources: [] };
  const key = crypto.createHash("sha1").update(query.toLowerCase()).digest("hex");
  const mem = researchMemory.get(key);
  if (mem && Date.now() - mem.at < ttlMs) return mem.data;
  const cacheFile = stateDir ? path.join(stateDir, "research", `${key}.json`) : null;
  if (cacheFile) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
      if (cached && Date.now() - Number(cached.at || 0) < ttlMs && cached.data) {
        researchMemory.set(key, cached);
        return cached.data;
      }
    } catch {
      /* no cache yet */
    }
  }
  const deadline = Date.now() + timeoutMs;
  const results = await ddgSearch(query, { limit: 5, timeoutMs: Math.max(1500, deadline - Date.now()) });
  const pages = [];
  const sources = [];
  const selected = results.slice(0, 4);
  await Promise.all(
    selected.map(async (result) => {
      const remaining = deadline - Date.now();
      const text = remaining > 800 ? await fetchPageText(result.url, { timeoutMs: Math.min(4500, remaining) }) : "";
      if (text) pages.push(text);
      sources.push({ title: result.title, url: result.url });
      if (result.snippet) pages.push(result.snippet);
    })
  );
  const facts = pickFacts(query, pages);
  const data = { facts, sources: sources.slice(0, 4) };
  const entry = { at: Date.now(), data };
  researchMemory.set(key, entry);
  if (researchMemory.size > 60) researchMemory.delete(researchMemory.keys().next().value);
  if (cacheFile) {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true }).catch(() => {});
    await fs.writeFile(cacheFile, JSON.stringify(entry)).catch(() => {});
  }
  return data;
}

/* ---------------- image search + download ---------------- */

function bingImageCandidates(html) {
  const out = [];
  const patterns = [/murl&quot;:&quot;(.*?)&quot;/g, /"murl"\s*:\s*"(.*?)"/g];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html))) {
      const decoded = decodeEntities(m[1]).replace(/\\u002f/gi, "/").replace(/\\\//g, "/");
      if (decoded.includes("&quot;")) continue;
      const url = safeHttpUrl(decoded);
      if (url) out.push(url.toString());
    }
  }
  return [...new Set(out)];
}

export async function searchImages(query, { limit = 6, timeoutMs = 7000 } = {}) {
  const q = encodeURIComponent(String(query || "").trim().slice(0, 120));
  if (!q) return [];
  const deadline = Date.now() + timeoutMs;
  /* DuckDuckGo images: fetch search page for the vqd token, then i.js JSON. */
  try {
    const page = await fetchCapped(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`, {
      timeoutMs: Math.max(1500, deadline - Date.now()),
      byteCap: 220 * 1024,
      accept: ["text/html"],
    });
    const vqd = /vqd=([\d-]+)/.exec(page.text || "");
    if (vqd) {
      const js = await fetchCapped(
        `https://duckduckgo.com/i.js?l=us-en&o=json&q=${q}&vqd=${vqd[1]}&f=,,,&p=1`,
        {
          timeoutMs: Math.max(1200, deadline - Date.now()),
          byteCap: 400 * 1024,
          headers: { Referer: "https://duckduckgo.com/", Accept: "application/json" },
        }
      );
      if (js.text) {
        const data = JSON.parse(js.text);
        const urls = (Array.isArray(data.results) ? data.results : [])
          .map((r) => safeHttpUrl(r.image)?.toString() || null)
          .filter(Boolean);
        if (urls.length) return [...new Set(urls)].slice(0, limit);
      }
    }
  } catch {
    /* fall through to Bing */
  }
  /* Bing Images HTML fallback. */
  try {
    const bing = await fetchCapped(`https://www.bing.com/images/search?q=${q}&form=HDRSC2&first=1`, {
      timeoutMs: Math.max(1500, deadline - Date.now()),
      byteCap: 500 * 1024,
      accept: ["text/html"],
    });
    return bingImageCandidates(bing.text || "").slice(0, limit);
  } catch {
    return [];
  }
}

const IMAGE_MAGIC = [
  { ext: "jpg", mime: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png", mime: "image/png", test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: "webp", mime: "image/webp", test: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
];

export async function downloadImage(url, { timeoutMs = 6000, maxBytes = 1500 * 1024 } = {}) {
  const target = safeHttpUrl(url);
  if (!target) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "image/*,*/*;q=0.6" },
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
        return null;
      }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks);
    const magic = IMAGE_MAGIC.find((entry) => entry.test(buffer));
    if (!magic || magic.ext === "webp") return null; /* pptx-safe formats only */
    return { buffer, ...magic };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* Assign 1..max real images to slides that ask for one. Mutates slides in
   place and returns the number of images actually attached. */
export async function attachDeckImages(slides, deckId, imagesDir, { max = 6, timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const slots = [];
  for (const slide of slides) {
    if (slots.length >= max) break;
    if (slide.layout !== "image" && slide.layout !== "split") continue;
    const query = String((slide.image && slide.image.query) || slide.title || "").trim().slice(0, 120);
    if (!query) continue;
    slots.push({ slide, query });
  }
  if (!slots.length) return 0;
  const dir = path.join(imagesDir, deckId);
  await fs.mkdir(dir, { recursive: true });
  const found = await Promise.all(
    slots.map(async (slot) => {
      const remaining = deadline - Date.now();
      if (remaining < 1500) return null;
      const candidates = await searchImages(slot.query, { limit: 6, timeoutMs: Math.min(6000, remaining) });
      for (const candidate of candidates) {
        if (Date.now() > deadline) break;
        const image = await downloadImage(candidate, { timeoutMs: Math.min(5000, Math.max(1200, deadline - Date.now())) });
        if (image) return { slot, image };
      }
      return null;
    })
  );
  let count = 0;
  for (const hit of found) {
    if (!hit) continue;
    count += 1;
    const name = `${String(count).padStart(2, "0")}.${hit.image.ext}`;
    await fs.writeFile(path.join(dir, name), hit.image.buffer);
    hit.slot.slide.image = {
      query: hit.slot.query,
      url: `/img/${deckId}/${name}`,
      credit: "via web search",
    };
  }
  /* Graceful degradation: a slide whose image never arrived falls back. */
  for (const slide of slides) {
    if ((slide.layout === "image" || slide.layout === "split") && !(slide.image && slide.image.url)) {
      if (Array.isArray(slide.bullets) && slide.bullets.length) slide.layout = "bullets";
      else if (slide.layout === "image") slide.layout = "section";
    }
  }
  return count;
}
