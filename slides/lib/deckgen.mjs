/* Z Slides - deck schema + prompt engineering.

   THE CONTRACT (streamed deck JSON, shared with the front-end worker):
   {
     title: str, subtitle: str,
     theme: { name: str, palette: [hex x6], mood: str },
     slides: [{
       layout: "cover|section|bullets|split|image|quote|stats|timeline|comparison|closing",
       title: str, subtitle?: str, bullets?: [str],
       image?:   { query: str, url: str, credit: str },
       stats?:   [{ value: str, label: str }],
       quote?:   { text: str, attribution: str },
       compare?: { left: {title, points[]}, right: {title, points[]} },
       timeline?:[{ when: str, what: str }],
       notes?: str
     }]
   }

   palette order (fixed): [bg, accent, text, muted, accent2, surface].
   For convenience the normalizer also mirrors bg/accent/text/muted onto the
   theme object so older clients keep working. */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const LAYOUTS = ["cover", "section", "bullets", "split", "image", "quote", "stats", "timeline", "comparison", "closing"];

const HEX = /^[0-9a-fA-F]{6}$/;
const FALLBACK = { bg: "14120E", accent: "D4A72C", text: "F7F3E8", muted: "C4BAA4" };

const STYLE_SEEDS = [
  "editorial magazine: oversized serif headlines, generous white space, one hero image",
  "bold keynote: huge statements, high-contrast blocks, dramatic numbers",
  "data story: charts-as-cards, stats forward, tight captions, timeline of milestones",
  "minimal luxury: quiet palette, fine rules, lots of breathing room",
  "startup pitch: punchy one-liners, split image/text rhythm, comparison table",
  "documentary: full-bleed imagery, quote interludes, chronological sections",
  "warm humanist: rounded cards, warm neutrals, friendly section dividers",
  "futurist: dark background, neon accent, angular section markers",
];

const hex = (value, fallback) => {
  const cleaned = String(value || "").trim().replace(/^#/, "");
  return HEX.test(cleaned) ? cleaned.toUpperCase() : fallback;
};

function toRgb(color) {
  return [0, 2, 4].map((i) => parseInt(color.slice(i, i + 2), 16));
}

function luminance(color) {
  const [r, g, b] = toRgb(color).map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a, b, ratio) {
  const ac = toRgb(a);
  const bc = toRgb(b);
  const out = ac.map((v, i) => Math.round(v * (1 - ratio) + bc[i] * ratio));
  return out.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function normalizeTheme(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const palette = Array.isArray(source.palette) ? source.palette.map((c) => hex(c, "")) : [];
  const bg = palette[0] || hex(source.bg, FALLBACK.bg);
  const accent = palette[1] || hex(source.accent, FALLBACK.accent);
  let text = palette[2] || hex(source.text, FALLBACK.text);
  const muted = palette[3] || hex(source.muted, FALLBACK.muted);
  const accent2 = palette[4] || hex(source.accent2, mix(accent, text, 0.35));
  const surface = palette[5] || hex(source.surface, mix(bg, text, 0.1));
  /* Readability guard: flip text if it does not clear 4.5:1 on the bg. */
  if (contrast(bg, text) < 4.5) text = luminance(bg) > 0.4 ? "111111" : "FFFFFF";
  const safeAccent = contrast(bg, accent) >= 1.8 ? accent : "D4A72C";
  const name = String(source.name || "").replace(/\s+/g, " ").trim().slice(0, 48) || "Custom";
  const mood = String(source.mood || "").replace(/\s+/g, " ").trim().slice(0, 80) || "designed for the topic";
  return {
    name,
    palette: [bg, safeAccent, text, muted, accent2, surface],
    mood,
    /* mirror for legacy consumers */
    bg,
    accent: safeAccent,
    text,
    muted,
    accent2,
    surface,
  };
}

const s = (value, max) => String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
const list = (value, maxItems, maxLen) =>
  (Array.isArray(value) ? value : []).map((entry) => s(entry, maxLen)).filter(Boolean).slice(0, maxItems);

function inferLayout(raw) {
  if (raw.stats && (Array.isArray(raw.stats) ? raw.stats.length : 0)) return "stats";
  if (raw.timeline && (Array.isArray(raw.timeline) ? raw.timeline.length : 0)) return "timeline";
  if (raw.compare && (raw.compare.left || raw.compare.right)) return "comparison";
  if (raw.quote && (raw.quote.text || typeof raw.quote === "string")) return "quote";
  if (raw.image) return Array.isArray(raw.bullets) && raw.bullets.length ? "split" : "image";
  if (Array.isArray(raw.bullets) && raw.bullets.length) return "bullets";
  return "section";
}

export function normalizeSlide(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  let layout = s(source.layout || source.type || source.kind, 20).toLowerCase();
  if (!LAYOUTS.includes(layout)) layout = inferLayout(source);
  const slide = { layout, title: s(source.title, 140) || "Untitled slide" };
  const subtitle = s(source.subtitle || source.kicker, 200);
  if (subtitle) slide.subtitle = subtitle;
  const notes = s(source.notes, 800);
  if (notes) slide.notes = notes;

  const bullets = list(source.bullets, 8, 240);
  const stats = (Array.isArray(source.stats) ? source.stats : [])
    .map((entry) => ({ value: s(entry && entry.value, 24), label: s(entry && entry.label, 80) }))
    .filter((entry) => entry.value || entry.label)
    .slice(0, 4);
  const timeline = (Array.isArray(source.timeline) ? source.timeline : [])
    .map((entry) => ({ when: s(entry && (entry.when || entry.date), 40), what: s(entry && (entry.what || entry.text), 160) }))
    .filter((entry) => entry.when || entry.what)
    .slice(0, 7);
  const quoteSource = source.quote && typeof source.quote === "object" ? source.quote : { text: typeof source.quote === "string" ? source.quote : "" };
  const quote = { text: s(quoteSource.text, 420), attribution: s(quoteSource.attribution || quoteSource.author, 120) };
  const compareSource = source.compare && typeof source.compare === "object" ? source.compare : {};
  const compareSide = (side) => ({
    title: s(side && side.title, 80),
    points: list(side && side.points, 6, 160),
  });
  const compare = { left: compareSide(compareSource.left), right: compareSide(compareSource.right) };
  const imageSource = source.image && typeof source.image === "object" ? source.image : {};
  let image = null;
  if (imageSource.query || imageSource.url) {
    image = { query: s(imageSource.query, 160), url: s(imageSource.url, 300), credit: s(imageSource.credit, 80) };
  }

  switch (layout) {
    case "cover":
    case "section":
    case "closing":
      break;
    case "split":
      slide.bullets = bullets;
      if (image) slide.image = image;
      if (!bullets.length && !image) layout = "section";
      if (!image) layout = bullets.length ? "bullets" : "section";
      break;
    case "image":
      if (!image) layout = bullets.length ? "bullets" : "section";
      break;
    case "quote":
      if (!quote.text) {
        if (bullets.length) layout = "bullets";
        else layout = "section";
      }
      break;
    case "stats":
      if (!stats.length) layout = bullets.length ? "bullets" : "section";
      break;
    case "timeline":
      if (!timeline.length) layout = bullets.length ? "bullets" : "section";
      break;
    case "comparison":
      if (!compare.left.points.length && !compare.right.points.length && !compare.left.title && !compare.right.title) {
        layout = bullets.length ? "bullets" : "section";
      }
      break;
    default:
      layout = "bullets";
  }
  slide.layout = layout;
  if (layout === "bullets") slide.bullets = bullets.length ? bullets : [slide.title];
  else if (bullets.length && (layout === "section" || layout === "cover" || layout === "closing")) slide.bullets = bullets;
  if (layout === "image") slide.image = image || { query: slide.title, url: "", credit: "" };
  if (layout === "split") slide.image = image || { query: slide.title, url: "", credit: "" };
  if (layout === "stats") slide.stats = stats;
  if (layout === "timeline") slide.timeline = timeline;
  if (layout === "quote") slide.quote = quote;
  if (layout === "comparison") slide.compare = compare;
  return slide;
}

export function normalizeDeck(parsed, maxPages = 20) {
  const source = parsed && typeof parsed === "object" ? parsed : {};
  const slides = (Array.isArray(source.slides) ? source.slides : [])
    .map(normalizeSlide)
    .slice(0, Math.max(1, Math.min(Number(maxPages) || 20, 40)));
  if (!slides.length) throw new Error("AI returned an empty deck; please try again");
  return {
    title: s(source.title, 140) || "Untitled presentation",
    subtitle: s(source.subtitle, 200),
    theme: normalizeTheme(source.theme),
    slides,
  };
}

/* Upgrade a deck stored before the layout schema existed (or any stored deck)
   without touching identity/permission fields. */
export function upgradeDeck(deck) {
  if (!deck || typeof deck !== "object") return deck;
  return {
    ...deck,
    subtitle: s(deck.subtitle, 200),
    theme: normalizeTheme(deck.theme),
    slides: (Array.isArray(deck.slides) ? deck.slides : []).map(normalizeSlide),
  };
}

export function layoutSequence(deck) {
  return (Array.isArray(deck && deck.slides) ? deck.slides : []).map((slide) => slide.layout || "bullets");
}

/* ---------------- global layout-sequence registry ---------------- */

const seqFile = (stateDir) => path.join(stateDir, "layout-seqs.json");

export async function recentLayoutSequences(stateDir, limit = 6) {
  try {
    const data = JSON.parse(await fs.readFile(seqFile(stateDir), "utf8"));
    return (Array.isArray(data) ? data : []).slice(0, limit);
  } catch {
    return [];
  }
}

export async function recordLayoutSequence(stateDir, sequence) {
  if (!Array.isArray(sequence) || sequence.length < 2) return;
  let all = [];
  try {
    all = JSON.parse(await fs.readFile(seqFile(stateDir), "utf8"));
  } catch {
    all = [];
  }
  const head = sequence.join(">");
  const rest = (Array.isArray(all) ? all : []).filter((entry) => entry && entry.seq !== head);
  rest.unshift({ seq: head, at: new Date().toISOString() });
  await fs.mkdir(stateDir, { recursive: true }).catch(() => {});
  await fs.writeFile(seqFile(stateDir), JSON.stringify(rest.slice(0, 40), null, 2)).catch(() => {});
}

/* Guarantee the new deck does not repeat a recently used layout sequence:
   if it matches one exactly, flip one interior bullets/section slide. */
export function ensureUniqueSequence(slides, recent) {
  const current = slides.map((slide) => slide.layout);
  const head = current.join(">");
  if (!recent.some((entry) => entry && entry.seq === head)) return slides;
  for (let i = 1; i < slides.length - 1; i += 1) {
    if (slides[i].layout === "bullets") {
      slides[i] = { ...slides[i], layout: "section", bullets: undefined };
      break;
    }
    if (slides[i].layout === "section") {
      slides[i] = { ...slides[i], layout: "bullets", bullets: slides[i].bullets && slides[i].bullets.length ? slides[i].bullets : [slides[i].title] };
      break;
    }
  }
  return slides;
}

/* ---------------- prompt ---------------- */

export function buildPrompt({ details, pages, invitees, research, avoidSequences } = {}) {
  const target = Math.max(1, Number(pages) || 12);
  const seed = STYLE_SEEDS[crypto.randomInt(STYLE_SEEDS.length)];
  const audience = invitees && invitees.length ? `Intended audience/invitees: ${invitees.join(", ")}.` : "";
  const facts = research && research.facts && research.facts.length
    ? `\nWeb research notes (real facts gathered from public pages; fold in only what is relevant, never mention the research):\n${research.facts.map((f) => `- ${f}`).join("\n")}`
    : "";
  const avoid = avoidSequences && avoidSequences.length
    ? `\nReuse warning: these layout sequences were used by recent decks - yours MUST NOT be identical to any of them:\n${avoidSequences
        .slice(0, 5)
        .map((entry) => `- ${entry.seq}`)
        .join("\n")}`
    : "";
  return [
    "You are a senior presentation designer. Create a visually varied, premium slide deck.",
    `Return STRICT JSON only, no markdown, no code fences, exactly this shape:`,
    `{"title":"Deck title","subtitle":"One-line deck subtitle","theme":{"name":"Short theme name","palette":["RRGGBB","RRGGBB","RRGGBB","RRGGBB","RRGGBB","RRGGBB"],"mood":"two words"},"slides":[{"layout":"cover","title":"...","subtitle":"...","notes":"speaker note"},{"layout":"bullets","title":"...","bullets":["..."],"notes":"..."},{"layout":"stats","title":"...","stats":[{"value":"42%","label":"..."}],"notes":"..."}]}`,
    `Allowed layout values ONLY: ${LAYOUTS.join(", ")}.`,
    `slides MUST contain EXACTLY ${target} slide objects - count them, fill every one, no placeholders.`,
    `Structural rules: slide 1 layout "cover"; last slide layout "closing"; use at least 2 "section" dividers; use at least 4 DISTINCT layouts overall; include at least 2 slides from [quote, stats, timeline, comparison, image]; never repeat the same layout 3 times in a row; avoid two adjacent slides with the same layout.`,
    `Per-layout fields: bullets -> bullets[3-5] (max 16 words each); stats -> 2-4 {value,label} (value is a short number/percent, label explains it); timeline -> 3-7 {when,what}; compare / comparison -> {"left":{"title","points":[3-5]},"right":{"title","points":[3-5]}}; quote -> {"text","attribution"}; image/split -> image {"query":"specific 2-6 word photo search"} plus bullets[2-4] for split.`,
    `Every slide has a short "notes" string with 1-2 sentences of speaker guidance.`,
    `Theme: derive from the topic's mood, make it distinctive, palette order is EXACTLY [background, accent, text, muted, secondary accent, surface] as 6-digit hex WITHOUT "#"; background must be dark or light enough that "text" is clearly readable; "accent" must pop on the background.`,
    `Content: specific and factual, no filler; lean on the brief.`,
    `Creative direction for THIS deck (apply consistently): ${seed}.`,
    `Make the layout rhythm feel designed for this specific deck - not a generic template.`,
    avoid,
    audience,
    facts,
    `Brief: ${details}`,
  ]
    .filter(Boolean)
    .join("\n");
}
