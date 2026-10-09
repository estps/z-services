/* Z Slides - server-side PPTX renderer.

   Every contract layout gets its own designed treatment (cover, section,
   bullets, split, full-bleed image, quote, stat cards, timeline, comparison,
   closing) built from the theme palette. Decks saved before the layout schema
   are upgraded through normalizeSlide first, so old decks still export. */

import fs from "node:fs";
import path from "node:path";
import { normalizeDeck, normalizeSlide, themeColors } from "./deckgen.mjs";

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
  const c = themeColors(theme);
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

  const renderCompose = (slide, index) => {
    const s = blank();
    const left = 0.9;
    const width = 11.55;
    if (slide.title) {
      s.addText(String(slide.title), { x: left, y: 0.55, w: width, h: 1.0, fontFace: SERIF, fontSize: 30, color: c.text, fit: "shrink" });
      rule(s, 0.93, 1.58, 1.15);
    }
    let y = slide.title ? 1.95 : 0.9;
    const blocks = (slide.blocks || []);
    blocks.forEach((b) => {
      if (y > 6.85) return;
      if (b.type === "kicker") {
        eyebrow(s, b.text, left, y, { size: 12 });
        y += 0.45;
      } else if (b.type === "title") {
        const size = b.size === "xl" ? 32 : b.size === "l" ? 27 : b.size === "s" ? 19 : 23;
        s.addText(String(b.text || ""), { x: left, y, w: width, h: 0.95, fontFace: SERIF, fontSize: size, color: c.text, fit: "shrink" });
        y += 1.0;
      } else if (b.type === "text") {
        s.addText(String(b.text || ""), { x: left, y, w: width, h: 1.1, fontFace: SANS, fontSize: 16, color: c.muted, lineSpacingMultiple: 1.25, fit: "shrink" });
        y += 1.2;
      } else if (b.type === "callout") {
        s.addShape("roundRect", { x: left, y, w: width, h: 1.0, fill: { color: c.surface }, line: { color: c.accent, width: 1 }, rectRadius: 0.08 });
        s.addText(String(b.text || ""), { x: left + 0.2, y: y + 0.08, w: width - 0.4, h: 0.84, valign: "middle", fontFace: SANS, fontSize: 15, color: c.text, fit: "shrink" });
        y += 1.15;
      } else if (b.type === "quote") {
        s.addShape("rect", { x: left, y, w: 0.05, h: 1.05, fill: { color: c.accent } });
        s.addText(String(b.text || ""), { x: left + 0.25, y, w: width - 0.25, h: 0.8, fontFace: SERIF, italic: true, fontSize: 20, color: c.text, fit: "shrink" });
        if (b.attribution) s.addText(String(b.attribution), { x: left + 0.25, y: y + 0.8, w: width - 0.25, h: 0.3, fontFace: SANS, fontSize: 11, color: c.accent });
        y += 1.25;
      } else if (b.type === "chips") {
        s.addText((b.items || []).join("      "), { x: left, y, w: width, h: 0.45, fontFace: SANS, fontSize: 14, color: c.accent, charSpacing: 1 });
        y += 0.6;
      } else if (b.type === "stat") {
        s.addText(String(b.value || ""), { x: left, y, w: 5.0, h: 0.85, fontFace: SERIF, fontSize: 40, color: c.accent, fit: "shrink" });
        s.addText(String(b.label || ""), { x: left, y: y + 0.82, w: width, h: 0.4, fontFace: SANS, fontSize: 14, color: c.muted });
        y += 1.4;
      } else if (b.type === "stats") {
        const items = (b.items || []).slice(0, 4);
        const gap = 0.3;
        const w2 = (width - gap * Math.max(0, items.length - 1)) / Math.max(1, items.length);
        items.forEach((it, i) => {
          const x = left + i * (w2 + gap);
          s.addShape("rect", { x, y, w: w2, h: 1.5, fill: { color: c.surface } });
          s.addShape("rect", { x, y, w: w2, h: 0.06, fill: { color: i % 2 ? c.accent2 : c.accent } });
          s.addText(String(it.value || ""), { x: x + 0.16, y: y + 0.12, w: w2 - 0.32, h: 0.78, valign: "middle", fontFace: SERIF, fontSize: 30, color: i % 2 ? c.accent2 : c.accent, fit: "shrink" });
          s.addText(String(it.label || ""), { x: x + 0.16, y: y + 0.92, w: w2 - 0.32, h: 0.5, fontFace: SANS, fontSize: 11, color: c.muted, fit: "shrink" });
        });
        y += 1.7;
      } else if (b.type === "list") {
        const points = (b.items || []).slice(0, 7);
        s.addText(bulletRuns(points, c.muted, 15), {
          x: left, y, w: width, h: Math.min(4.2, 0.42 * points.length + 0.3), fontFace: SANS, fontSize: 15, lineSpacingMultiple: 1.15,
        });
        y += Math.min(4.2, 0.42 * points.length + 0.35);
      } else if (b.type === "divider") {
        rule(s, left, y, 1.3);
        y += 0.3;
      } else if (b.type === "spacer") {
        y += 0.3;
      }
    });
    pageNo(s, index);
    notes(s, slide);
  };

  const renderHero = (slide, index) => {
    const s = blank();
    if (slide.subtitle) {
      s.addText(String(slide.subtitle).toUpperCase(), { x: 0.8, y: 2.0, w: 11.7, h: 0.4, align: "center", fontFace: SANS, fontSize: 12, bold: true, color: c.accent, charSpacing: 3 });
    }
    s.addText(String(slide.title || ""), { x: 0.8, y: 2.5, w: 11.7, h: 2.4, align: "center", valign: "middle", fontFace: SERIF, fontSize: 54, color: c.text, fit: "shrink" });
    const pts = (slide.bullets || []).slice(0, 4);
    if (pts.length) s.addText(pts.join("      "), { x: 0.8, y: 5.0, w: 11.7, h: 0.6, align: "center", fontFace: SANS, fontSize: 14, color: c.muted });
    pageNo(s, index);
    notes(s, slide);
  };

  const renderBand = (slide, index) => {
    const s = blank();
    s.addShape("rect", { x: 0.9, y: 0.8, w: 0.08, h: 1.6, fill: { color: c.accent } });
    if (slide.subtitle) s.addText(String(slide.subtitle).toUpperCase(), { x: 1.2, y: 0.82, w: 10, h: 0.35, fontFace: SANS, fontSize: 11, bold: true, color: c.accent, charSpacing: 3 });
    s.addText(String(slide.title || ""), { x: 1.15, y: 1.2, w: 11, h: 1.15, fontFace: SERIF, fontSize: 34, color: c.text, fit: "shrink" });
    const pts = (slide.bullets || []).slice(0, 6);
    if (pts.length) s.addText(bulletRuns(pts, c.muted, 16), { x: 1.1, y: 2.8, w: 6.4, h: 3.9, fontFace: SANS, fontSize: 16, lineSpacingMultiple: 1.2 });
    const stats = (slide.stats || []).slice(0, 3);
    stats.forEach((st, i) => {
      const y = 2.8 + i * 1.35;
      s.addShape("rect", { x: 7.9, y, w: 4.5, h: 1.15, fill: { color: c.surface } });
      s.addText(String(st.value || ""), { x: 8.05, y: y + 0.06, w: 4.2, h: 0.55, fontFace: SERIF, fontSize: 24, color: c.accent, fit: "shrink" });
      s.addText(String(st.label || ""), { x: 8.05, y: y + 0.62, w: 4.2, h: 0.45, fontFace: SANS, fontSize: 12, color: c.muted, fit: "shrink" });
    });
    pageNo(s, index);
    notes(s, slide);
  };

  const renderSidebar = (slide, index) => {
    const s = blank();
    s.addShape("rect", { x: 0, y: 0, w: 4.5, h: H, fill: { color: c.surface } });
    if (slide.subtitle) s.addText(String(slide.subtitle).toUpperCase(), { x: 0.55, y: 2.1, w: 3.6, h: 0.35, fontFace: SANS, fontSize: 11, bold: true, color: c.accent, charSpacing: 3 });
    s.addText(String(slide.title || ""), { x: 0.5, y: 2.5, w: 3.7, h: 2.4, fontFace: SERIF, fontSize: 30, color: c.text, fit: "shrink" });
    rule(s, 0.55, 5.1, 1.1);
    const pts = (slide.bullets || []).slice(0, 6);
    if (pts.length) s.addText(bulletRuns(pts, c.muted, 16), { x: 5.1, y: 1.5, w: 7.4, h: 4.4, fontFace: SANS, fontSize: 16, lineSpacingMultiple: 1.25 });
    const stats = (slide.stats || []).slice(0, 2);
    stats.forEach((st, i) => {
      const x = 5.1 + i * 3.8;
      s.addText(String(st.value || ""), { x, y: 6.0, w: 3.5, h: 0.7, fontFace: SERIF, fontSize: 30, color: c.accent, fit: "shrink" });
      s.addText(String(st.label || ""), { x, y: 6.72, w: 3.5, h: 0.4, fontFace: SANS, fontSize: 11, color: c.muted, fit: "shrink" });
    });
    pageNo(s, index);
    notes(s, slide);
  };

  const renderPanels = (slide, index) => {
    const s = blank();
    s.addText(String(slide.title || ""), { x: 0.9, y: 0.6, w: 11.6, h: 1.0, align: "center", fontFace: SERIF, fontSize: 30, color: c.text, fit: "shrink" });
    const cmp = slide.compare || {};
    let sides = [cmp.left || {}, cmp.right || {}];
    const has = sides.some((x) => x && x.points && x.points.length);
    if (!has && (slide.bullets || []).length) {
      const half = Math.ceil(slide.bullets.length / 2);
      sides = [{ title: "", points: slide.bullets.slice(0, half) }, { title: "", points: slide.bullets.slice(half) }];
    }
    sides.forEach((side, i) => {
      const x = 0.9 + i * 6.0;
      s.addShape("rect", { x, y: 2.0, w: 5.5, h: 4.6, fill: { color: c.surface } });
      s.addShape("rect", { x, y: 2.0, w: 5.5, h: 0.12, fill: { color: i ? c.accent2 : c.accent } });
      if (side.title) s.addText(String(side.title), { x: x + 0.3, y: 2.25, w: 4.9, h: 0.6, fontFace: SANS, fontSize: 16, bold: true, color: c.text, fit: "shrink" });
      const pts = (side.points || []).slice(0, 6);
      if (pts.length) s.addText(bulletRuns(pts, c.muted, 14), { x: x + 0.3, y: 3.0, w: 4.9, h: 3.4, fontFace: SANS, fontSize: 14, lineSpacingMultiple: 1.2 });
    });
    pageNo(s, index);
    notes(s, slide);
  };

  const renderBigNumber = (slide, index) => {
    const s = blank();
    const stat = (slide.stats && slide.stats[0]) || { value: slide.title, label: slide.subtitle };
    s.addText(String(stat.value || ""), { x: 1.0, y: 1.6, w: 11.3, h: 3.1, align: "center", valign: "middle", fontFace: SERIF, fontSize: 150, color: c.accent, fit: "shrink" });
    if (stat.label) s.addText(String(stat.label), { x: 2.0, y: 4.9, w: 9.3, h: 1.0, align: "center", fontFace: SANS, fontSize: 20, color: c.muted, fit: "shrink" });
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
    compose: renderCompose,
    hero: renderHero,
    band: renderBand,
    sidebar: renderSidebar,
    panels: renderPanels,
    bigNumber: renderBigNumber,
    closing: renderClosing,
  };

  slides.forEach((slide, index) => {
    const render = renderers[slide.layout] || renderBullets;
    render(slide, index);
  });

  return await pptx.write({ outputType: "nodebuffer" });
}
