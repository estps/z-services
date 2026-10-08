/* Z Slides - server-side PPTX renderer.

   Every contract layout gets its own designed treatment (cover, section,
   bullets, split, full-bleed image, quote, stat cards, timeline, comparison,
   closing) built from the theme palette. Decks saved before the layout schema
   are upgraded through normalizeSlide first, so old decks still export. */

import fs from "node:fs";
import path from "node:path";
import { normalizeDeck, normalizeSlide } from "./deckgen.mjs";

const W = 13.333;
const H = 7.5;
const SERIF = "Georgia";
const SANS = "Segoe UI";

function imageDataFor(url, imagesDir) {
  if (!url || typeof url !== "string" || !url.startsWith("/img/")) return null;
  const root = path.resolve(imagesDir);
  const target = path.resolve(root, url.slice("/img/".length));
  if (!target.startsWith(root + path.sep) && target !== root) return null;
  try {
    const buffer = fs.readFileSync(target);
    const ext = path.extname(target).toLowerCase();
    const mime = ext === ".png" ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function buildPptx(deck, { imagesDir = "/srv/zslides/state/images" } = {}) {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const normalized = normalizeDeck(
    {
      title: deck.title,
      subtitle: deck.subtitle,
      theme: deck.theme,
      slides: (Array.isArray(deck.slides) ? deck.slides : []).map(normalizeSlide),
    },
    Math.max(1, (deck.slides || []).length || 20)
  );
  const theme = normalized.theme;
  const c = {
    bg: theme.bg,
    accent: theme.accent,
    text: theme.text,
    muted: theme.muted,
    accent2: theme.accent2,
    surface: theme.surface,
  };
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "Z16x9", width: W, height: H });
  pptx.layout = "Z16x9";
  pptx.title = normalized.title;
  pptx.subject = normalized.subtitle || "Presentation";

  const slides = normalized.slides;
  const total = slides.length;

  const blank = (bg = c.bg) => {
    const s = pptx.addSlide();
    s.background = { color: bg };
    return s;
  };

  const rule = (s, x, y, w, color = c.accent, h = 0.045) =>
    s.addShape("rect", { x, y, w, h, fill: { color } });

  const eyebrow = (s, value, x, y, opts = {}) =>
    s.addText(String(value || "").toUpperCase(), {
      x, y, w: opts.w || 6, h: 0.4, fontFace: SANS, fontSize: opts.size || 11,
      color: opts.color || c.accent, charSpacing: 3, bold: opts.bold !== false,
    });

  const pageNo = (s, index) => {
    s.addText(`${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`, {
      x: 11.6, y: 7.03, w: 1.45, h: 0.32, align: "right", fontFace: SANS, fontSize: 9, color: c.muted,
    });
  };

  const notes = (s, slide) => {
    if (slide.notes) s.addNotes(slide.notes);
  };

  const addImage = (s, slide, x, y, w, h, sizing = "cover") => {
    const data = imageDataFor(slide.image && slide.image.url, imagesDir);
    if (!data) return false;
    s.addImage({ data, x, y, w, h, sizing: { type: sizing, w, h } });
    return true;
  };

  const credit = (s, slide, x, y, align = "right", color = c.muted) => {
    if (!slide.image || !slide.image.url) return;
    s.addText(`Image: ${slide.image.credit || "via web search"}`, {
      x, y, w: 4.5, h: 0.26, align, fontFace: SANS, fontSize: 8, color,
    });
  };

  const bulletRuns = (points, color, size = 18) =>
    points.map((point, i) => ({
      text: String(point),
      options: {
        bullet: { code: "25C6" },
        color,
        fontSize: size,
        breakLine: true,
        paraSpaceAfter: 8,
      },
    }));

  /* ---------------- layout renderers ---------------- */

  const renderCover = (slide, index) => {
    const s = blank();
    s.addShape("rect", { x: 0, y: 0, w: 0.34, h: H, fill: { color: c.accent } });
    s.addShape("rect", { x: 0.34, y: 0, w: 0.06, h: H, fill: { color: c.accent2 } });
    eyebrow(s, "presentation", 1.15, 1.15);
    const title = String(slide.title || normalized.title || "Presentation");
    s.addText(title, {
      x: 1.05, y: 1.65, w: 10.7, h: 2.55, valign: "top", fontFace: SERIF,
      fontSize: title.length > 64 ? 34 : title.length > 40 ? 40 : 50, color: c.text, lineSpacingMultiple: 0.98, charSpacing: 0.5,
    });
    rule(s, 1.1, 4.5, 1.9);
    const subtitle = slide.subtitle || normalized.subtitle;
    if (subtitle) {
      s.addText(subtitle, { x: 1.1, y: 4.75, w: 9.9, h: 0.95, fontFace: SANS, fontSize: 18, color: c.muted, lineSpacingMultiple: 1.15 });
    }
    s.addText(normalized.title, { x: 1.1, y: 6.75, w: 9.5, h: 0.4, fontFace: SANS, fontSize: 10, color: c.muted });
    s.addShape("rect", { x: 10.9, y: 0, w: 2.433, h: H, fill: { color: c.surface } });
    s.addText("Z", { x: 10.9, y: 5.1, w: 2.433, h: 1.6, align: "center", fontFace: SERIF, fontSize: 90, color: c.accent, transparency: 35 });
    pageNo(s, index);
    notes(s, slide);
  };

  const renderSection = (slide, index) => {
    const s = blank();
    s.addShape("rect", { x: 0, y: 0, w: W, h: 0.16, fill: { color: c.accent } });
    const num = String(index + 1).padStart(2, "0");
    s.addText(num, {
      x: 0.85, y: 1.35, w: 3.4, h: 4.4, valign: "middle", fontFace: SERIF, fontSize: 150, color: c.accent2, transparency: 45,
    });
    s.addText(String(slide.title || ""), {
      x: 4.35, y: 2.25, w: 8.1, h: 1.7, valign: "middle", fontFace: SERIF, fontSize: 40, color: c.text, lineSpacingMultiple: 1.0,
    });
    rule(s, 4.4, 4.1, 1.6, c.accent);
    if (slide.subtitle) {
      s.addText(slide.subtitle, { x: 4.4, y: 4.35, w: 7.7, h: 1.1, fontFace: SANS, fontSize: 17, color: c.muted, lineSpacingMultiple: 1.15 });
    }
    pageNo(s, index);
    notes(s, slide);
  };

  const renderBullets = (slide, index) => {
    const s = blank();
    s.addText(String(slide.title || ""), {
      x: 0.9, y: 0.55, w: 11.6, h: 1.05, fontFace: SERIF, fontSize: 30, color: c.text, fit: "shrink",
    });
    rule(s, 0.93, 1.6, 1.15);
    const points = (slide.bullets || []).slice(0, 6);
    if (points.length) {
      s.addText(bulletRuns(points, c.muted), {
        x: 1.0, y: 2.0, w: 11.3, h: 4.6, fontFace: SANS, fontSize: 18, lineSpacingMultiple: 1.25,
      });
    } else if (slide.subtitle) {
      s.addText(slide.subtitle, { x: 1.0, y: 2.2, w: 11.0, h: 2.0, fontFace: SANS, fontSize: 20, color: c.muted });
    }
    pageNo(s, index);
    notes(s, slide);
  };

  const renderSplit = (slide, index) => {
    const s = blank();
    const hasImage = slide.image && slide.image.url && addImage(s, slide, 7.55, 0, W - 7.55, H, "cover");
    if (!hasImage) return renderBullets(slide, index);
    s.addShape("rect", { x: 7.55, y: 0, w: W - 7.55, h: H, fill: { color: c.bg, transparency: 78 } });
    s.addText(String(slide.title || ""), {
      x: 0.85, y: 0.75, w: 6.35, h: 1.5, fontFace: SERIF, fontSize: 32, color: c.text, fit: "shrink", lineSpacingMultiple: 1.0,
    });
    rule(s, 0.9, 2.35, 1.15);
    const points = (slide.bullets || []).slice(0, 5);
    if (points.length) {
      s.addText(bulletRuns(points, c.muted, 16), {
        x: 0.95, y: 2.7, w: 6.2, h: 4.0, fontFace: SANS, fontSize: 16, lineSpacingMultiple: 1.22,
      });
    }
    s.addShape("rect", { x: 7.55, y: 0, w: 0.04, h: H, fill: { color: c.accent } });
    credit(s, slide, 10.1, 7.03, "right", c.muted);
    pageNo(s, index);
    notes(s, slide);
  };

  const renderImage = (slide, index) => {
    const s = blank();
    const hasImage = slide.image && slide.image.url && addImage(s, slide, 0, 0, W, H, "cover");
    if (!hasImage) return renderBullets(slide, index);
    s.addShape("rect", { x: 0, y: 0, w: W, h: H, fill: { color: c.bg, transparency: 42 } });
    s.addShape("rect", { x: 0, y: 5.6, w: W, h: 1.9, fill: { color: c.bg, transparency: 18 } });
    rule(s, 0.9, 5.82, 1.5);
    s.addText(String(slide.title || ""), {
      x: 0.9, y: 5.95, w: 11.5, h: 0.85, fontFace: SERIF, fontSize: 34, color: c.text, fit: "shrink",
    });
    if (slide.subtitle) {
      s.addText(slide.subtitle, { x: 0.93, y: 6.75, w: 10.4, h: 0.5, fontFace: SANS, fontSize: 13, color: c.text, transparency: 25 });
    }
    credit(s, slide, 10.4, 7.03, "right", c.text);
    pageNo(s, index);
    notes(s, slide);
  };

  const renderQuote = (slide, index) => {
    const s = blank();
    s.addText("\u201C", { x: 0.7, y: 0.15, w: 3, h: 2.2, fontFace: SERIF, fontSize: 150, color: c.accent, transparency: 30 });
    const quote = slide.quote || {};
    s.addText(String(quote.text || ""), {
      x: 1.75, y: 1.55, w: 9.9, h: 3.3, valign: "middle", align: "center",
      fontFace: SERIF, italic: true, fontSize: String(quote.text || "").length > 180 ? 24 : 30,
      color: c.text, lineSpacingMultiple: 1.25, fit: "shrink",
    });
    rule(s, 6.0, 5.15, 1.35, c.accent);
    s.addText(String(quote.attribution || ""), {
      x: 3.3, y: 5.35, w: 6.7, h: 0.5, align: "center", fontFace: SANS, fontSize: 15, color: c.accent, charSpacing: 1.5,
    });
    pageNo(s, index);
    notes(s, slide);
  };

  const renderStats = (slide, index) => {
    const s = blank();
    s.addText(String(slide.title || ""), { x: 0.9, y: 0.55, w: 11.6, h: 1.0, fontFace: SERIF, fontSize: 30, color: c.text, fit: "shrink" });
    rule(s, 0.93, 1.58, 1.15);
    const stats = (slide.stats || []).slice(0, 4);
    const gap = 0.35;
    const width = (11.55 - gap * (stats.length - 1)) / Math.max(1, stats.length);
    stats.forEach((stat, i) => {
      const x = 0.9 + i * (width + gap);
      s.addShape("rect", { x, y: 2.35, w: width, h: 3.15, fill: { color: c.surface } });
      s.addShape("rect", { x, y: 2.35, w: width, h: 0.09, fill: { color: i % 2 ? c.accent2 : c.accent } });
      s.addText(String(stat.value || ""), {
        x: x + 0.25, y: 2.65, w: width - 0.5, h: 1.45, valign: "middle", fontFace: SERIF, fontSize: 44, color: i % 2 ? c.accent2 : c.accent, fit: "shrink",
      });
      s.addText(String(stat.label || ""), {
        x: x + 0.25, y: 4.15, w: width - 0.5, h: 1.1, valign: "top", fontFace: SANS, fontSize: 14, color: c.muted, lineSpacingMultiple: 1.15,
      });
    });
    pageNo(s, index);
    notes(s, slide);
  };

  const renderTimeline = (slide, index) => {
    const s = blank();
    s.addText(String(slide.title || ""), { x: 0.9, y: 0.55, w: 11.6, h: 1.0, fontFace: SERIF, fontSize: 30, color: c.text, fit: "shrink" });
    rule(s, 0.93, 1.58, 1.15);
    const entries = (slide.timeline || []).slice(0, 6);
    const top = 2.15;
    const bottom = 6.75;
    if (entries.length > 1) {
      const step = (bottom - top) / (entries.length - 1);
      s.addShape("rect", { x: 2.55, y: top, w: 0.035, h: bottom - top, fill: { color: c.accent } });
      entries.forEach((entry, i) => {
        const y = top + i * step - 0.16;
        s.addShape("ellipse", { x: 2.4, y, w: 0.35, h: 0.35, fill: { color: i % 2 ? c.accent2 : c.accent } });
        s.addText(String(entry.when || ""), {
          x: 0.75, y: y - 0.08, w: 1.5, h: 0.5, align: "right", fontFace: SANS, fontSize: 13, bold: true, color: c.accent,
        });
        s.addText(String(entry.what || ""), {
          x: 3.05, y: y - 0.12, w: 9.3, h: 0.62, fontFace: SANS, fontSize: 16, color: c.muted, fit: "shrink", lineSpacingMultiple: 1.05,
        });
      });
    } else if (entries.length === 1) {
      s.addText(`${entries[0].when || ""} - ${entries[0].what || ""}`, { x: 1.0, y: 2.5, w: 11.3, h: 2, fontFace: SANS, fontSize: 20, color: c.muted });
    }
    pageNo(s, index);
    notes(s, slide);
  };

  const renderComparison = (slide, index) => {
    const s = blank();
    s.addText(String(slide.title || ""), { x: 0.9, y: 0.55, w: 11.6, h: 1.0, fontFace: SERIF, fontSize: 30, color: c.text, fit: "shrink" });
    rule(s, 0.93, 1.58, 1.15);
    const compare = slide.compare || { left: {}, right: {} };
    const panel = (side, x, headColor) => {
      s.addShape("rect", { x, y: 2.05, w: 5.55, h: 4.55, fill: { color: c.surface } });
      s.addShape("rect", { x, y: 2.05, w: 5.55, h: 0.75, fill: { color: headColor } });
      s.addText(String(side.title || ""), {
        x: x + 0.28, y: 2.13, w: 5.0, h: 0.6, valign: "middle", fontFace: SANS, fontSize: 17, bold: true, color: c.bg,
      });
      const points = (side.points || []).slice(0, 6);
      if (points.length) {
        s.addText(bulletRuns(points, c.muted, 14), {
          x: x + 0.28, y: 3.0, w: 5.0, h: 3.45, fontFace: SANS, fontSize: 14, lineSpacingMultiple: 1.18,
        });
      }
    };
    panel(compare.left || {}, 0.9, c.accent);
    panel(compare.right || {}, 6.88, c.accent2);
    s.addShape("ellipse", { x: 6.31, y: 3.95, w: 0.72, h: 0.72, fill: { color: c.bg }, line: { color: c.accent, width: 1.5 } });
    s.addText("VS", { x: 6.31, y: 3.95, w: 0.72, h: 0.72, align: "center", valign: "middle", fontFace: SANS, fontSize: 12, bold: true, color: c.accent });
    pageNo(s, index);
    notes(s, slide);
  };

  const renderClosing = (slide, index) => {
    const s = blank();
    s.addShape("rect", { x: 0, y: H - 0.16, w: W, h: 0.16, fill: { color: c.accent } });
    s.addText(String(slide.title || "Thank you"), {
      x: 1.2, y: 2.2, w: 10.9, h: 1.6, align: "center", valign: "middle", fontFace: SERIF, fontSize: 52, color: c.text, fit: "shrink",
    });
    rule(s, 5.9, 4.0, 1.55);
    const subtitle = slide.subtitle || normalized.subtitle;
    if (subtitle) {
      s.addText(subtitle, { x: 2.2, y: 4.3, w: 8.9, h: 0.9, align: "center", fontFace: SANS, fontSize: 16, color: c.muted });
    }
    s.addText(normalized.title, { x: 2.2, y: 6.6, w: 8.9, h: 0.4, align: "center", fontFace: SERIF, italic: true, fontSize: 12, color: c.accent });
    pageNo(s, index);
    notes(s, slide);

  };

  const renderers = {
    cover: renderCover,
    section: renderSection,
    bullets: renderBullets,
    split: renderSplit,
    image: renderImage,
    quote: renderQuote,
    stats: renderStats,
    timeline: renderTimeline,
    comparison: renderComparison,
    closing: renderClosing,
  };

  slides.forEach((slide, index) => {
    const render = renderers[slide.layout] || renderBullets;
    render(slide, index);
  });

  return await pptx.write({ outputType: "nodebuffer" });
}
