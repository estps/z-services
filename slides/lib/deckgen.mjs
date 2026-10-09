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

export const LAYOUTS = ["cover", "section", "bullets", "split", "image", "quote", "stats", "timeline", "comparison", "compose", "closing"];

/* Block vocabulary for the "compose" layout: the model builds each slide from
   an ordered list of blocks laid out on a 3-column grid, so no two slides have
   to share a fixed template. */
export const BLOCK_TYPES = ["kicker", "title", "text", "list", "stat", "stats", "quote", "callout", "chips", "divider", "spacer"];

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

/* Palette families: the generator is asked to start from one family per deck
   and adapt its hues to the topic, so consecutive decks do not look alike.
   (8 families >= the "5+ palette families" requirement.) */
const THEME_FAMILIES = [
  "midnight gallery: near-black ground, warm brass accent, ivory text, graphite muted",
  "arctic paper: off-white ground, deep teal accent, slate text, one signal red",
  "terracotta studio: cream ground, burnt clay accent, espresso text, olive secondary",
  "neon futurist: deep indigo ground, electric cyan accent, pale mint text, magenta secondary",
  "royal editorial: ink-navy ground, gold accent, porcelain text, oxblood secondary",
  "sage field: bone ground, forest accent, bark text, ochre secondary",
  "coral pop: white ground, coral accent, midnight text, sky secondary",
  "monochrome luxe: jet ground, silver text, one single accent hue chosen from the topic",
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

function saturation(color) {
  const [r, g, b] = toRgb(color);
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

function mix(a, b, ratio) {
  const ac = toRgb(a);
  const bc = toRgb(b);
  const out = ac.map((v, i) => Math.round(v * (1 - ratio) + bc[i] * ratio));
  return out.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function bestInk(bg, palette) {
  let best = null;
  let bestContrast = 0;
  for (const color of palette) {
    const value = contrast(bg, color);
    if (value > bestContrast) {
      bestContrast = value;
      best = color;
    }
  }
  if (best && bestContrast >= 4.5) return best;
  return luminance(bg) > 0.55 ? "111111" : "FFFFFF";
}

function firstAccent(bg, palette, ink) {
  let best = null;
  let bestScore = -1;
  for (const color of palette) {
    if (color === bg || color === ink) continue;
    const value = contrast(bg, color);
    if (value < 1.5) continue;
    const score = saturation(color) * 2 + Math.min(value, 6) * 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = color;
    }
  }
  return best;
}

/* The emitted theme is EXACTLY the contract shape:
   { name, palette: [bg, accent, text, muted, accent2, surface], mood }.
   The front-end derives its own ink/accent from the palette; the PPTX
   renderer calls themeColors() below for concrete roles. */
export function normalizeTheme(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const sourcePalette = Array.isArray(source.palette) ? source.palette : [];
  const fromPalette = (i) => hex(sourcePalette[i], "");
  const bg = fromPalette(0) || hex(source.bg, FALLBACK.bg);
  const accent = fromPalette(1) || hex(source.accent, FALLBACK.accent);
  const text = fromPalette(2) || hex(source.text, FALLBACK.text);
  const muted = fromPalette(3) || hex(source.muted, FALLBACK.muted);
  const accent2 = fromPalette(4) || hex(source.accent2, mix(accent, text, 0.35));
  const surface = fromPalette(5) || hex(source.surface, mix(bg, text, 0.1));
  const palette = [bg, accent, text, muted, accent2, surface];
  /* Readability guards: make sure at least one palette color reads on bg and
     that the accent is visible; otherwise the site/pptx fall back to noise. */
  const ink = bestInk(bg, palette);
  const safeInk = ink === text ? text : ink;
  const safeAccent = contrast(bg, accent) >= 1.5 ? accent : firstAccent(bg, palette, safeInk) || FALLBACK.accent;
  const name = String(source.name || "").replace(/\s+/g, " ").trim().slice(0, 48) || "Custom";
  const mood = String(source.mood || "").replace(/\s+/g, " ").trim().slice(0, 80) || "designed for the topic";
  return { name, palette: [bg, safeAccent, safeInk, muted, accent2, surface], mood };
}

/* Concrete roles for server-side rendering (PPTX). */
export function themeColors(raw) {
  const theme = normalizeTheme(raw);
  const palette = theme.palette.slice();
  const bg = palette[0];
  const ink = bestInk(bg, palette);
  const accents = palette
    .filter((color) => color !== bg && color !== ink && contrast(bg, color) >= 1.2)
    .sort((a, b) => saturation(b) * 2 + contrast(bg, b) * 0.3 - (saturation(a) * 2 + contrast(bg, a) * 0.3));
  const accent = accents[0] || FALLBACK.accent;
  let accent2 = accents[1] || mix(accent, ink, 0.4);
  if (accent2 === accent) accent2 = mix(accent, ink, 0.4);
  const dark = luminance(bg) < 0.45;
  return {
    bg,
    accent,
    accent2,
    text: ink,
    muted: mix(ink, bg, 0.4),
    surface: dark ? mix(bg, "FFFFFF", 0.07) : mix(bg, "000000", 0.05),
    dark,
    name: theme.name,
    mood: theme.mood,
    palette,
  };
}

const s = (value, max) => String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
const list = (value, maxItems, maxLen) =>
  (Array.isArray(value) ? value : []).map((entry) => s(entry, maxLen)).filter(Boolean).slice(0, maxItems);

function normalizeBlocks(raw) {
  const blocks = (Array.isArray(raw) ? raw : []).map((entry) => {
    const src = entry && typeof entry === "object" ? entry : {};
    let type = s(src.type || src.kind, 16).toLowerCase();
    if (!BLOCK_TYPES.includes(type)) type = Array.isArray(src.items) || Array.isArray(src.bullets) ? "list" : "text";
    const block = { type };
    if (type === "title" || type === "text" || type === "callout" || type === "kicker") {
      block.text = s(src.text != null ? src.text : src.value, type === "kicker" ? 80 : 400);
    } else if (type === "quote") {
      block.text = s(src.text, 420);
      const attribution = s(src.attribution || src.author, 120);
      if (attribution) block.attribution = attribution;
    } else if (type === "list") {
      block.items = list(src.items || src.bullets, 8, 200);
      if (src.numbered) block.numbered = true;
      if (Number(src.columns) === 2) block.columns = 2;
    } else if (type === "chips") {
      block.items = list(src.items, 8, 40);
    } else if (type === "stat") {
      block.value = s(src.value, 24);
      block.label = s(src.label, 80);
    } else if (type === "stats") {
      block.items = (Array.isArray(src.items || src.stats) ? src.items || src.stats : [])
        .map((item) => ({ value: s(item && item.value, 24), label: s(item && item.label, 80) }))
        .filter((item) => item.value || item.label)
        .slice(0, 4);
    }
    if (["s", "m", "l", "xl"].includes(src.size)) block.size = src.size;
    if (["left", "center", "right"].includes(src.align)) block.align = src.align;
    const span = Number(src.span);
    if (span >= 1 && span <= 3) block.span = Math.round(span);
    return block;
  });
  return blocks
    .filter((block) => {
      if (block.type === "divider" || block.type === "spacer") return true;
      if (block.type === "list" || block.type === "chips" || block.type === "stats") return block.items && block.items.length;
      if (block.type === "stat") return block.value || block.label;
      return Boolean(block.text);
    })
    .slice(0, 10);
}

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
  const blocks = normalizeBlocks(source.blocks);
  if (blocks.length >= 2) layout = "compose";
  const subtitle = s(source.subtitle || source.kicker, 200);
  const bullets = list(source.bullets, 8, 240);
  const slide = { layout, title: s(source.title, 140) || subtitle || bullets[0] || "Overview" };
  if (subtitle) slide.subtitle = subtitle;
  const notes = s(source.notes, 800);
  if (notes) slide.notes = notes;

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
    case "compose":
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
  if (layout === "compose") slide.blocks = blocks;
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
  repairAdjacent(slides);
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

/* The model occasionally emits two dividers (or two bullet slides) in a row.
   Flip the later one; cover/closing are never touched. */
function repairAdjacent(slides) {
  for (let i = 1; i < slides.length - 1; i += 1) {
    if (slides[i].layout !== slides[i - 1].layout) continue;
    if (slides[i].layout === "section") {
      slides[i] = {
        ...slides[i],
        layout: "bullets",
        bullets: slides[i].bullets && slides[i].bullets.length ? slides[i].bullets : [slides[i].title],
      };
    } else if (slides[i].layout === "bullets") {
      slides[i] = { ...slides[i], layout: "section", bullets: undefined };
    }
  }
  return slides;
}

/* Guarantee the new deck does not repeat a recently used layout sequence:
   if it matches one exactly, flip interior bullets/section slides until the
   sequence is new (bounded attempts, first/last slides stay cover/closing).
   Also removes adjacent duplicate section/bullets slides. */
export function ensureUniqueSequence(slides, recent) {
  if (!Array.isArray(slides) || slides.length < 3) return slides;
  const used = new Set(
    (Array.isArray(recent) ? recent : []).map((entry) => (entry && typeof entry === "object" ? entry.seq : entry)).filter(Boolean)
  );
  const head = () => slides.map((slide) => slide.layout).join(">");
  const interior = slides.length - 2;
  const flip = (i) => {
    const slide = slides[i];
    if (slide.layout === "bullets") {
      slides[i] = { ...slide, layout: "section", bullets: undefined };
    } else if (slide.layout === "section") {
      slides[i] = {
        ...slide,
        layout: "bullets",
        bullets: slide.bullets && slide.bullets.length ? slide.bullets : [slide.title],
      };
    }
  };
  repairAdjacent(slides);
  for (let attempt = 0; used.size && attempt < interior * 2 && used.has(head()); attempt += 1) {
    flip(1 + (attempt % interior));
    repairAdjacent(slides);
  }
  return slides;
}

/* ---------------- prompt ---------------- */

export function buildPrompt({ details, pages, invitees, research, avoidSequences, detail } = {}) {
  const target = Math.max(1, Number(pages) || 12);
  const seed = STYLE_SEEDS[crypto.randomInt(STYLE_SEEDS.length)];
  const family = THEME_FAMILIES[crypto.randomInt(THEME_FAMILIES.length)];
  const detailLevel = Math.max(1, Math.min(5, Math.round(Number(detail) || 3)));
  const detailGuide = [
    "",
    "Lean: minimal - short titles, at most 2 short bullets of 8 words or fewer, no filler; favour one strong statement per slide.",
    "Light: concise - 3-4 short bullets or one tight sentence; only the essentials.",
    "Balanced: 3-5 bullets of up to 14 words, or one short paragraph; one clear idea per block.",
    "Detailed: 4-6 bullets or a full paragraph per slide; add supporting specifics, examples and numbers.",
    "In-depth: rich and thorough - 5-7 bullets or two paragraphs, extra stats, concrete examples, figures and nuance; every slide should teach something.",
  ][detailLevel];
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
  const structure =
    target >= 6
      ? `Structural rules: slide 1 layout "cover"; last slide layout "closing"; use at least 2 "section" dividers; use at least 4 DISTINCT layouts overall; prefer "compose" for most content slides (aim for at least half) and use [quote, stats, timeline, comparison, image, split] for the rest; give every compose slide a DIFFERENT block arrangement; never repeat the same layout 3 times in a row; avoid two adjacent slides with the same layout.`
      : `Structural rules: slide 1 layout "cover"; if there are 3+ slides make the last one "closing"; prefer "compose" for content slides; use at least 2 distinct layouts; avoid two adjacent slides with the same layout.`;
  return [
    "You are a senior presentation designer. Create a visually varied, premium slide deck.",
    `Return STRICT JSON only, no markdown, no code fences, exactly this shape:`,
    `{"title":"Deck title","subtitle":"One-line deck subtitle","theme":{"name":"Short theme name","palette":["RRGGBB","RRGGBB","RRGGBB","RRGGBB","RRGGBB","RRGGBB"],"mood":"two words"},"slides":[{"layout":"cover","title":"...","subtitle":"...","notes":"speaker note"},{"layout":"compose","title":"...","blocks":[{"type":"kicker","text":"..."},{"type":"title","text":"...","size":"l"},{"type":"text","text":"...","span":2},{"type":"stat","value":"42%","label":"...","span":1}],"notes":"..."},{"layout":"stats","title":"...","stats":[{"value":"42%","label":"..."}],"notes":"..."}]}`,
    `Allowed layout values ONLY: ${LAYOUTS.join(", ")}.`,
    `slides MUST contain EXACTLY ${target} slide objects - count them, fill every one, no placeholders.`,
    `Every slide - including section dividers - must have a specific, descriptive title; never output an empty or "Untitled" title.`,
    structure,
    `Per-layout fields: bullets -> bullets[3-5] (max 16 words each); stats -> 2-4 {value,label} (value is a short number/percent, label explains it); timeline -> 3-7 {when,what}; compare / comparison -> {"left":{"title","points":[3-5]},"right":{"title","points":[3-5]}}; quote -> {"text","attribution"}; image/split -> image {"query":"specific 2-6 word photo search"} plus bullets[2-4] for split.`,
    `Compose blocks (layout "compose"): blocks is an ORDERED array; types: kicker{text}, title{text,size:s|m|l|xl}, text{text,size}, list{items[],numbered?,columns?:1|2}, stat{value,label}, stats{items[{value,label}]}, quote{text,attribution}, callout{text}, chips{items[]}, divider{}, spacer{}. Every block may set span (1-3 columns of a 3-column grid) and align (left|center|right). Put 4-9 blocks per slide, vary the spans (e.g. a span:2 text next to a span:1 stat) and never reuse the same arrangement on another slide.`,
    `Every slide has a short "notes" string with 1-2 sentences of speaker guidance.`,
    `Theme: derive from the topic's mood, make it distinctive, palette order is EXACTLY [background, accent, text, muted, secondary accent, surface] as 6-digit hex WITHOUT "#"; background must be dark or light enough that "text" is clearly readable; "accent" must pop on the background.`,
    `Palette family to start from (adapt its hues to the topic instead of copying it blindly; stay in this family's temperature and contrast): ${family}.`,
    `Content: specific and factual, no filler; lean on the brief.`,
    `Creative direction for THIS deck (apply consistently): ${seed}.`,
    `Make the layout rhythm feel designed for this specific deck - not a generic template.`,
    avoid,
    audience,
    facts,
    `Content detail level (${detailLevel}/5): ${detailGuide}`,
    `Brief: ${details}`,
  ]
    .filter(Boolean)
    .join("\n");
}
