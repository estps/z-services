/* Z Slides - deck renderer.
 * Renders the deck JSON contract into fixed 1280x720 "canvas" slides that are
 * scaled to fit any container (preview grid, streaming build, presentation mode, print).
 *
 * Contract (new): { title, subtitle, theme:{ name, palette:[hex..], mood },
 *   slides:[{ layout, title, subtitle?, bullets?, image?, stats?, quote?,
 *             compare?, timeline?, notes? }] }
 * Legacy support: theme:{bg,accent,text,muted} (hex without '#') and slides with only title/bullets.
 */
(function () {
  "use strict";

  var DESIGN_W = 1280;
  var DESIGN_H = 720;
  var LAYOUT_NAMES = ["cover", "section", "bullets", "split", "image", "quote", "stats", "timeline", "comparison", "compose", "closing"];
  var FALLBACK_PALETTE = ["1E1B16", "C9A227", "FFFFFF", "CFC6AE"];

  /* ------------------------------------------------------------- color utils */

  function normHex(value) {
    if (value === null || value === undefined) return null;
    var s = String(value).trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(s)) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    return /^[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : null;
  }

  function hexRgb(hex) {
    var h = normHex(hex) || "000000";
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function rgbHex(r, g, b) {
    return [r, g, b].map(function (v) {
      var h = clamp(Math.round(v), 0, 255).toString(16).toUpperCase();
      return h.length === 1 ? "0" + h : h;
    }).join("");
  }

  function mix(a, b, t) {
    var ca = hexRgb(a), cb = hexRgb(b);
    return rgbHex(ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t);
  }

  function rgba(hex, alpha) {
    var c = hexRgb(hex);
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (alpha === undefined ? 1 : alpha) + ")";
  }

  function relLum(hex) {
    var c = hexRgb(hex).map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function contrast(a, b) {
    var l1 = relLum(a), l2 = relLum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function saturation(hex) {
    var c = hexRgb(hex);
    var mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    return mx === 0 ? 0 : (mx - mn) / mx;
  }

  function rotate(hex, deg, light) {
    var c = hexRgb(hex).map(function (v) { return v / 255; });
    var mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    var l = (mx + mn) / 2, h = 0, s = 0;
    if (mx !== mn) {
      var d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === c[0] ? ((c[1] - c[2]) / d + (c[1] < c[2] ? 6 : 0)) : mx === c[1] ? ((c[2] - c[0]) / d + 2) : ((c[0] - c[1]) / d + 4);
      h *= 60;
    }
    h = (h + deg) % 360; if (h < 0) h += 360;
    if (light !== undefined && light !== null) l = light;
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    function hue(t) {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    return rgbHex(hue(h / 360 + 1 / 3) * 255, hue(h / 360) * 255, hue(h / 360 - 1 / 3) * 255);
  }

  /* -------------------------------------------------------------- seed utils */

  function hash(str) {
    var h = 2166136261 >>> 0;
    str = String(str || "");
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function pick(seed, salt, arr) { return arr[hash(seed + "|" + salt) % arr.length]; }
  function rnd(seed, salt, count) { return hash(seed + "|" + salt) % count; }

  /* ------------------------------------------------------------ theme families */

  var FAMILIES = [
    { key: "midnight", re: /midnight|navy|tech|cyber|space|night|noir-blue/i, motifs: ["grid", "orbits", "rings"], radii: [10, 14, 18], display: "sans", weight: 800, spacing: "-0.02em" },
    { key: "ocean", re: /ocean|sea|water|sky|teal|aqua|wave|marine/i, motifs: ["waves", "dots", "rings"], radii: [18, 24, 30], display: "sans", weight: 750, spacing: "-0.01em" },
    { key: "ember", re: /ember|warm|sunset|fire|autumn|energy|sport|heat/i, motifs: ["blobs", "rays", "stripes"], radii: [14, 20, 26], display: "sans", weight: 850, spacing: "-0.02em" },
    { key: "paper", re: /paper|editorial|elegant|luxury|luxe|classic|heritage|history|serif/i, motifs: ["dots", "grid", "rings"], radii: [4, 6, 10], display: "serif", weight: 700, spacing: "-0.01em" },
    { key: "mint", re: /mint|fresh|nature|forest|eco|calm|wellness|garden|green/i, motifs: ["blobs", "waves", "dots"], radii: [22, 28, 34], display: "sans", weight: 700, spacing: "0" },
    { key: "sunrise", re: /sunrise|golden|summer|happy|sunny|yellow|orange|festival/i, motifs: ["rays", "blobs", "orbits"], radii: [16, 22, 28], display: "sans", weight: 800, spacing: "-0.01em" },
    { key: "violet", re: /violet|purple|neon|playful|creative|fun|party|pink|magenta/i, motifs: ["rings", "stripes", "blobs"], radii: [20, 26, 32], display: "sans", weight: 850, spacing: "-0.02em" },
    { key: "mono", re: /mono|minimal|corporate|professional|business|executive|swiss|architect/i, motifs: ["grid", "stripes", "dots"], radii: [2, 4, 8], display: "sans", weight: 700, spacing: "-0.02em" },
    { key: "noir", re: /noir|cinematic|drama|stealth|dark/i, motifs: ["orbits", "rings", "stripes"], radii: [12, 16, 22], display: "sans", weight: 800, spacing: "-0.01em" },
    { key: "studio", re: /studio|clean|modern|product|portfolio|design/i, motifs: ["grid", "blobs", "waves"], radii: [12, 18, 24], display: "sans", weight: 750, spacing: "-0.01em" }
  ];

  function detectFamily(name, mood, dark, seed) {
    var text = (name + " " + mood).toLowerCase();
    for (var i = 0; i < FAMILIES.length; i++) {
      if (FAMILIES[i].re.test(text)) return FAMILIES[i];
    }
    var generic = dark
      ? { key: "noir", motifs: ["orbits", "rings", "grid", "blobs"], radii: [10, 16, 22], display: "sans", weight: 800, spacing: "-0.02em" }
      : { key: "studio", motifs: ["grid", "dots", "waves", "blobs"], radii: [8, 14, 20], display: "sans", weight: 750, spacing: "-0.01em" };
    if (pick(seed, "serif-flip", [0, 1, 2]) === 0) generic.display = "serif";
    return generic;
  }

  function bestInk(bg, palette) {
    var best = null, bestC = 0;
    for (var i = 0; i < palette.length; i++) {
      var c = contrast(bg, palette[i]);
      if (c > bestC) { bestC = c; best = palette[i]; }
    }
    if (best && bestC >= 4.5) return best;
    return relLum(bg) > 0.55 ? "111318" : "FFFFFF";
  }

  function firstAccent(bg, palette, not) {
    var best = null, bestScore = -1;
    for (var i = 0; i < palette.length; i++) {
      var c = palette[i];
      if (c === bg || c === not) continue;
      var con = contrast(bg, c);
      if (con < 1.5) continue;
      var score = saturation(c) * 2 + Math.min(con, 6) * 0.3;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  var SERIF = 'Georgia,"Iowan Old Style","Palatino Linotype","Times New Roman",serif';
  var SANS = '"Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,Roboto,"Helvetica Neue",Arial,sans-serif';
  var MONO = '"Cascadia Mono",Consolas,"SF Mono",Menlo,monospace';

  function normalizeTheme(raw) {
    if (raw && raw.__z) return raw;
    raw = (raw && typeof raw === "object") ? raw : {};
    var name = String(raw.name || "").trim();
    var mood = String(raw.mood || "").trim();
    var palette = [];
    if (Array.isArray(raw.palette)) {
      palette = raw.palette.map(normHex).filter(Boolean);
    }
    var legacyBg = normHex(raw.bg);
    var legacyAccent = normHex(raw.accent);
    var legacyText = normHex(raw.text);
    var legacyMuted = normHex(raw.muted);

    var bg, ink, accent, accent2, muted, surface, line, soft, soft2;
    if (legacyBg) {
      bg = legacyBg;
      ink = legacyText || bestInk(bg, palette.concat(FALLBACK_PALETTE));
      accent = legacyAccent || rotate(bg, 180, relLum(bg) > 0.5 ? 0.35 : 0.6);
      accent2 = palette[0] && palette[0] !== accent ? palette[0] : mix(accent, ink, 0.35);
      muted = legacyMuted || mix(ink, bg, 0.42);
      if (!palette.length) palette = [legacyAccent || accent, legacyText || ink, legacyBg, legacyMuted || muted].filter(Boolean);
    } else {
      if (!palette.length) palette = FALLBACK_PALETTE.slice();
      bg = palette[0];
      ink = bestInk(bg, palette);
      accent = firstAccent(bg, palette, ink) || rotate(bg, 180, relLum(bg) > 0.5 ? 0.34 : 0.62);
      accent2 = firstAccent(bg, palette, accent) || mix(accent, ink, 0.4);
      if (accent2 === accent) accent2 = mix(accent, ink, 0.4);
      muted = mix(ink, bg, 0.4);
    }

    var dark = relLum(bg) < 0.45;
    surface = dark ? mix(bg, "#FFFFFF", 0.07) : mix(bg, "#000000", 0.05);
    line = dark ? mix(bg, "#FFFFFF", 0.16) : mix(bg, "#000000", 0.12);
    soft = rgba(accent, 0.13);
    soft2 = rgba(accent2, 0.13);

    var seed = hash(name + "~" + mood + "~" + palette.join("") + "~" + raw.title);
    var family = detectFamily(name, mood, dark, seed);
    var displayFont = family.display === "serif" ? SERIF : family.display === "mono" ? MONO : SANS;
    if (/elegant|luxury|serif|editorial|classic/i.test(mood + name)) displayFont = SERIF;
    if (/tech|code|monospace|developer/i.test(mood + name)) displayFont = MONO;

    var t = {
      __z: true,
      name: name,
      mood: mood,
      palette: palette,
      dark: dark,
      bg: bg,
      bg2: dark ? mix(bg, "#FFFFFF", 0.05) : mix(bg, "#000000", 0.035),
      ink: ink,
      muted: muted,
      accent: accent,
      accent2: accent2,
      surface: surface,
      line: line,
      soft: soft,
      soft2: soft2,
      radius: pick(seed, "radius", family.radii),
      radiusLg: Math.round(pick(seed, "radius", family.radii) * 1.6),
      fontDisplay: displayFont,
      fontBody: SANS,
      weight: family.weight,
      spacing: family.spacing,
      motif: pick(seed, "motif", family.motifs),
      coverStyle: pick(seed, "cover", ["left", "center", "band", "frame"]),
      family: family.key,
      seed: seed
    };
    return t;
  }

  function themeVars(t) {
    var v = {
      "--d-bg": "#" + t.bg,
      "--d-bg2": "#" + t.bg2,
      "--d-surface": "#" + t.surface,
      "--d-ink": "#" + t.ink,
      "--d-muted": "#" + t.muted,
      "--d-accent": "#" + t.accent,
      "--d-accent-2": "#" + t.accent2,
      "--d-line": rgba(t.ink, 0.14),
      "--d-line-strong": rgba(t.ink, 0.28),
      "--d-soft": rgba(t.accent, 0.13),
      "--d-soft-2": rgba(t.accent2, 0.14),
      "--d-glow": rgba(t.accent, t.dark ? 0.22 : 0.14),
      "--d-radius": t.radius + "px",
      "--d-radius-lg": t.radiusLg + "px",
      "--d-display": t.fontDisplay,
      "--d-body": t.fontBody,
      "--d-weight": String(t.weight),
      "--d-sp": t.spacing,
      "--d-scrim": rgba(t.dark ? "000000" : t.ink, t.dark ? 0.62 : 0.35)
    };
    return v;
  }

  /* ------------------------------------------------------------------ helpers */

  function tag(name, cls, text) {
    var n = document.createElement(name);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function div(cls, text) { return tag("div", cls, text); }
  function span(cls, text) { return tag("span", cls, text); }

  function setSvg(host, markup) { host.innerHTML = markup; }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  /* ------------------------------------------------------------------- icons */

  var ICONS = {
    check: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 12.5l5 5L20 6.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cross: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 12h15M13 5.5L19.5 12 13 18.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    quote: '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><path d="M20 10C12 14 8 21 8 30c0 5 3 8 7 8s7-3 7-7c0-3.6-2.6-6-6-6-.7 0-1.5.1-2 .4.6-4 3.4-7.4 8-9.6L20 10zm20 0c-8 4-12 11-12 20 0 5 3 8 7 8s7-3 7-7c0-3.6-2.6-6-6-6-.7 0-1.5.1-2 .4.6-4 3.4-7.4 8-9.6L40 10z" fill="currentColor"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="M4 17.5l4.5-4.5 3.5 3.5 3-3L20 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7v5.4l3.4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    spark: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l2.2 6.4L21 10l-5.6 3.6L17 21l-5-4-5 4 1.6-7.4L3 10l6.8-1.6L12 2z" fill="currentColor"/></svg>',
    target: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg>'
  };

  function icon(host, name, cls) {
    var wrap = div("dc-ico" + (cls ? " " + cls : ""));
    wrap.innerHTML = ICONS[name] || ICONS.spark;
    return wrap;
  }

  /* ------------------------------------------------------------------ motifs */

  function motifSvg(kind, t, uid, density) {
    var a = "#" + t.accent, a2 = "#" + t.accent2, ink = "#" + t.ink;
    var d = density === undefined ? 1 : density;
    var line = rgba(t.ink, 0.1 * d);
    var soft = rgba(t.accent, 0.14 * d);
    var soft2 = rgba(t.accent2, 0.12 * d);
    switch (kind) {
      case "grid":
        return '<svg viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' +
          '<defs><pattern id="g' + uid + '" width="46" height="46" patternUnits="userSpaceOnUse"><path d="M46 0H0v46" fill="none" stroke="' + line + '" stroke-width="1"/></pattern></defs>' +
          '<rect width="1280" height="720" fill="url(#g' + uid + ')"/>' +
          '<rect x="812" y="-150" width="380" height="380" rx="70" fill="' + soft + '"/>' +
          '<circle cx="1150" cy="610" r="180" fill="none" stroke="' + a + '" stroke-opacity="' + 0.22 * d + '" stroke-width="2"/>' +
          '<circle cx="1150" cy="610" r="116" fill="none" stroke="' + a + '" stroke-opacity="' + 0.12 * d + '" stroke-width="2"/></svg>';
      case "orbits":
        return '<svg viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' +
          '<circle cx="1040" cy="170" r="230" fill="none" stroke="' + rgba(t.accent, 0.18 * d) + '" stroke-width="2"/>' +
          '<circle cx="1040" cy="170" r="150" fill="none" stroke="' + rgba(t.accent2, 0.16 * d) + '" stroke-width="2"/>' +
          '<circle cx="1040" cy="170" r="72" fill="' + soft + '"/>' +
          '<circle cx="1230" cy="310" r="14" fill="' + a + '" fill-opacity="' + 0.5 * d + '"/>' +
          '<circle cx="840" cy="60" r="8" fill="' + a2 + '" fill-opacity="' + 0.45 * d + '"/>' +
          '<circle cx="940" cy="640" r="150" fill="none" stroke="' + line + '" stroke-width="1.5"/></svg>';
      case "blobs":
        return '<svg viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' +
          '<defs><radialGradient id="b1' + uid + '"><stop offset="0" stop-color="' + a + '" stop-opacity="' + 0.28 * d + '"/><stop offset="1" stop-color="' + a + '" stop-opacity="0"/></radialGradient>' +
          '<radialGradient id="b2' + uid + '"><stop offset="0" stop-color="' + a2 + '" stop-opacity="' + 0.24 * d + '"/><stop offset="1" stop-color="' + a2 + '" stop-opacity="0"/></radialGradient></defs>' +
          '<circle cx="1080" cy="90" r="420" fill="url(#b1' + uid + ')"/>' +
          '<circle cx="120" cy="660" r="380" fill="url(#b2' + uid + ')"/>' +
          '<circle cx="620" cy="-80" r="230" fill="url(#b1' + uid + ')"/></svg>';
      case "waves":
        return '<svg viewBox="0 0 1280 720" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
          '<path d="M0 560 C 180 470 340 650 560 560 S 960 470 1280 570 L1280 720 L0 720 Z" fill="' + soft + '"/>' +
          '<path d="M0 630 C 220 540 400 700 640 620 S 1020 540 1280 650 L1280 720 L0 720 Z" fill="' + soft2 + '"/>' +
          '<path d="M0 560 C 180 470 340 650 560 560 S 960 470 1280 570" fill="none" stroke="' + rgba(t.accent, 0.35 * d) + '" stroke-width="2"/></svg>';
      case "dots":
        return '<svg viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' +
          '<defs><pattern id="p' + uid + '" width="34" height="34" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="2" fill="' + line + '"/></pattern></defs>' +
          '<rect width="1280" height="720" fill="url(#p' + uid + ')"/>' +
          '<circle cx="1080" cy="580" r="220" fill="' + soft + '"/>' +
          '<circle cx="1080" cy="580" r="150" fill="none" stroke="' + rgba(t.accent, 0.3 * d) + '" stroke-width="2"/></svg>';
      case "rings":
        return '<svg viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' +
          '<circle cx="1110" cy="180" r="250" fill="none" stroke="' + rgba(t.accent, 0.2 * d) + '" stroke-width="2"/>' +
          '<circle cx="960" cy="420" r="190" fill="none" stroke="' + rgba(t.accent2, 0.18 * d) + '" stroke-width="2"/>' +
          '<circle cx="1190" cy="560" r="130" fill="' + soft + '"/>' +
          '<circle cx="150" cy="120" r="90" fill="none" stroke="' + line + '" stroke-width="2"/></svg>';
      case "stripes":
        return '<svg viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' +
          '<defs><pattern id="s' + uid + '" width="26" height="26" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="10" height="26" fill="' + line + '"/></pattern></defs>' +
          '<rect width="1280" height="720" fill="url(#s' + uid + ')"/>' +
          '<rect x="900" y="-120" width="500" height="500" rx="60" fill="' + soft + '"/>' +
          '<rect x="1000" y="520" width="280" height="18" rx="9" fill="' + rgba(t.accent, 0.4 * d) + '"/></svg>';
      case "rays":
        return '<svg viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' +
          '<g transform="translate(1280 -40) rotate(12)" fill="' + rgba(t.accent, 0.16 * d) + '">' +
          '<rect x="-560" y="0" width="520" height="100" rx="50"/><rect x="-420" y="150" width="520" height="100" rx="50"/>' +
          '<rect x="-560" y="300" width="520" height="100" rx="50" fill="' + rgba(t.accent2, 0.16 * d) + '"/><rect x="-330" y="450" width="520" height="100" rx="50"/></g>' +
          '<circle cx="180" cy="640" r="230" fill="' + soft + '"/></svg>';
      default:
        return "";
    }
  }

  function coverDecor(t, ctx) {
    var uid = ctx.uid;
    var a = "#" + t.accent, a2 = "#" + t.accent2;
    var base = motifSvg(ctx.motif, t, uid, t.dark ? 1.1 : 0.9);
    var style = t.coverStyle;
    var extra;
    if (style === "center") {
      extra = '<svg viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="640" cy="330" r="330" fill="none" stroke="' + rgba(t.accent, 0.22) + '" stroke-width="2"/>' +
        '<circle cx="640" cy="330" r="230" fill="none" stroke="' + rgba(t.accent2, 0.18) + '" stroke-width="2"/>' +
        '<circle cx="640" cy="330" r="96" fill="' + rgba(t.accent, 0.14) + '"/></svg>';
    } else if (style === "band") {
      extra = '<svg viewBox="0 0 1280 720" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="0" y="0" width="92" height="720" fill="' + a + '"/>' +
        '<rect x="92" y="0" width="10" height="720" fill="' + a2 + '"/>' +
        '<polygon points="1280,0 1280,240 980,0" fill="' + rgba(t.accent2, 0.45) + '"/></svg>';
    } else if (style === "frame") {
      extra = '<svg viewBox="0 0 1280 720" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="38" y="38" width="1204" height="644" fill="none" stroke="' + rgba(t.ink, 0.35) + '" stroke-width="2"/>' +
        '<rect x="54" y="54" width="1172" height="612" fill="none" stroke="' + rgba(t.accent, 0.45) + '" stroke-width="1"/>' +
        '<rect x="38" y="38" width="10" height="10" fill="' + a + '"/><rect x="1232" y="672" width="10" height="10" fill="' + a + '"/></svg>';
    } else {
      extra = '<svg viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="1070" cy="360" r="250" fill="none" stroke="' + rgba(t.accent, 0.28) + '" stroke-width="2"/>' +
        '<circle cx="1070" cy="360" r="176" fill="none" stroke="' + rgba(t.accent2, 0.22) + '" stroke-width="2"/>' +
        '<circle cx="1070" cy="360" r="104" fill="' + rgba(t.accent, 0.16) + '"/>' +
        '<rect x="920" y="566" width="300" height="16" rx="8" fill="' + a + '"/>' +
        '<rect x="920" y="598" width="180" height="16" rx="8" fill="' + rgba(t.ink, 0.25) + '"/></svg>';
    }
    return base + extra;
  }

  function decorFor(cv, ctx) {
    var t = ctx.theme;
    var deco = div("dc-decor dc-decor--" + (ctx.layout === "cover" ? "cover" : "corner") + " dc-decor--" + (["tr", "br", "bl", "tl"][(ctx.index + t.seed) % 4]));
    setSvg(deco, ctx.layout === "cover" ? coverDecor(t, ctx) : motifSvg(ctx.motif, t, ctx.uid, 0.7));
    cv.appendChild(deco);
    if (ctx.layout !== "cover") cv.appendChild(div("dc-glow"));
  }

  /* -------------------------------------------------------------- normalization */

  function asText(v) { return v === null || v === undefined ? "" : String(v); }
  function asList(v) { return Array.isArray(v) ? v : []; }

  function normStats(v) {
    return asList(v).map(function (x) {
      if (Array.isArray(x)) return { value: asText(x[0]), label: asText(x[1]) };
      if (x && typeof x === "object") return { value: asText(x.value), label: asText(x.label) };
      return { value: asText(x), label: "" };
    }).filter(function (x) { return x.value || x.label; });
  }

  function normTimeline(v) {
    return asList(v).map(function (x) {
      if (x && typeof x === "object") return { when: asText(x.when || x.date || x.time), what: asText(x.what || x.title || x.text) };
      return { when: "", what: asText(x) };
    }).filter(function (x) { return x.when || x.what; });
  }

  function normCompare(v) {
    if (!v || typeof v !== "object") return null;
    var normSide = function (s) {
      s = (s && typeof s === "object") ? s : {};
      return {
        title: asText(s.title || s.label),
        points: asList(s.points || s.bullets).map(asText).filter(Boolean)
      };
    };
    var left = normSide(v.left), right = normSide(v.right);
    if (!left.title && !left.points.length && !right.title && !right.points.length) return null;
    return { left: left, right: right };
  }

  function normImage(v) {
    if (!v) return null;
    if (typeof v === "string") return { url: v, query: "", credit: "" };
    if (typeof v !== "object") return null;
    return { url: asText(v.url), query: asText(v.query), credit: asText(v.credit) };
  }

  function normQuote(v) {
    if (!v) return null;
    if (typeof v === "string") return { text: v, attribution: "" };
    if (typeof v !== "object") return null;
    return { text: asText(v.text), attribution: asText(v.attribution) };
  }

  function normBlocks(raw) {
    return asList(raw).map(function (entry) {
      var src = (entry && typeof entry === "object") ? entry : {};
      var type = asText(src.type || src.kind).toLowerCase();
      var block = { type: type };
      if (type === "list") block.items = asList(src.items || src.bullets).map(asText).filter(Boolean);
      else if (type === "stats") block.items = normStats(src.items || src.stats);
      else if (type === "chips") block.items = asList(src.items).map(asText).filter(Boolean);
      else if (type === "stat") { block.value = asText(src.value); block.label = asText(src.label); }
      else if (type === "quote") { block.text = asText(src.text); block.attribution = asText(src.attribution); }
      else block.text = asText(src.text != null ? src.text : src.value);
      var size = asText(src.size).toLowerCase();
      block.size = ["s", "m", "l", "xl"].indexOf(size) >= 0 ? size : "";
      var align = asText(src.align).toLowerCase();
      block.align = ["left", "center", "right"].indexOf(align) >= 0 ? align : "";
      var span = Number(src.span);
      if (span >= 1 && span <= 3) block.span = Math.round(span);
      if (type === "list" && src.numbered) block.numbered = true;
      if (type === "list" && Number(src.columns) === 2) block.columns = 2;
      if (type === "kicker") block.text = block.text || asText(src.kicker);
      return block;
    }).filter(function (b) {
      if (b.type === "divider" || b.type === "spacer") return true;
      if (b.type === "list" || b.type === "chips" || b.type === "stats") return b.items && b.items.length;
      if (b.type === "stat") return b.value || b.label;
      return Boolean(b.text);
    }).slice(0, 10);
  }

  function normalizeSlide(raw) {
    if (raw && raw.__z) return raw;
    raw = (raw && typeof raw === "object") ? raw : {};
    return {
      __z: true,
      layout: asText(raw.layout).toLowerCase().trim(),
      title: asText(raw.title),
      subtitle: asText(raw.subtitle),
      bullets: asList(raw.bullets).map(asText).filter(Boolean),
      image: normImage(raw.image),
      stats: normStats(raw.stats),
      quote: normQuote(raw.quote),
      compare: normCompare(raw.compare),
      timeline: normTimeline(raw.timeline),
      blocks: normBlocks(raw.blocks),
      notes: asText(raw.notes)
    };
  }

  function resolveLayout(s, index, total) {
    if (LAYOUT_NAMES.indexOf(s.layout) >= 0) return s.layout;
    if (index === 0) return "cover";
    if (total > 3 && index === total - 1) return "closing";
    if (s.quote && s.quote.text) return "quote";
    if (s.stats.length) return "stats";
    if (s.timeline.length) return "timeline";
    if (s.compare) return "comparison";
    if (s.image) return s.bullets.length ? "split" : "image";
    return "bullets";
  }

  /* ------------------------------------------------------------ shared blocks */

  function chrome(cv, ctx) {
    if (ctx.layout === "cover" || ctx.layout === "closing") return;
    var bar = div("dc-chrome");
    bar.appendChild(span("dc-chrome-mark", "Z"));
    if (ctx.deckTitle) bar.appendChild(span("dc-chrome-title", ctx.deckTitle));
    var pg = div("dc-chrome-page");
    pg.appendChild(tag("b", null, pad(ctx.index + 1)));
    if (ctx.total) pg.appendChild(span(null, " / " + pad(ctx.total)));
    bar.appendChild(pg);
    cv.appendChild(bar);
  }

  function titleBlock(cls, text, opts) {
    opts = opts || {};
    var h = tag(opts.h || "h2", cls, text || "");
    var len = (text || "").length;
    if (len > 92) h.classList.add("is-xxlong");
    else if (len > 54) h.classList.add("is-xlong");
    else if (len > 34) h.classList.add("is-long");
    return h;
  }

  function mediaBlock(s, ctx, cls) {
    var wrap = div("dc-media " + (cls || ""));
    var img = s.image || {};
    if (img.url) {
      var im = document.createElement("img");
      im.className = "dc-media-img";
      im.alt = img.query || s.title || "";
      im.loading = "lazy";
      im.src = img.url;
      im.addEventListener("error", function () { wrap.classList.add("is-missing"); });
      wrap.appendChild(im);
    } else {
      wrap.classList.add("is-placeholder");
      var ph = div("dc-media-ph");
      ph.appendChild(icon(null, "image"));
      var label = img.query || s.title || "Image";
      ph.appendChild(span("dc-media-ph-label", label));
      wrap.appendChild(ph);
    }
    if (img.credit) wrap.appendChild(span("dc-media-credit", img.credit));
    return wrap;
  }

  /* ------------------------------------------------------------------ layouts */

  var LAYOUTS = {};

  LAYOUTS.cover = function (cv, s, ctx) {
    var t = ctx.theme;
    cv.classList.add("dc-cover--" + t.coverStyle);
    decorFor(cv, ctx);
    var body = div("dc-body dc-cover");
    var kicker = [t.mood || t.name, ctx.subtitle].filter(Boolean)[0];
    if (kicker) body.appendChild(div("dc-kicker", String(kicker).toUpperCase()));
    body.appendChild(titleBlock("dc-cover-title", s.title || ctx.deckTitle || "Untitled presentation", { h: "h1" }));
    body.appendChild(div("dc-rule"));
    if (s.subtitle) body.appendChild(tag("p", "dc-cover-sub", s.subtitle));
    var chips = div("dc-chips");
    if (ctx.total) chips.appendChild(span("dc-chip", ctx.total + (ctx.total === 1 ? " slide" : " slides")));
    if (t.name && String(t.name).toLowerCase() !== String(kicker || "").toLowerCase()) chips.appendChild(span("dc-chip dc-chip--ghost", t.name));
    if (chips.childNodes.length) body.appendChild(chips);
    cv.appendChild(body);
    chrome(cv, ctx);
  };

  LAYOUTS.section = function (cv, s, ctx) {
    decorFor(cv, ctx);
    var body = div("dc-body dc-section");
    cv.appendChild(div("dc-section-num", ctx.total ? pad(ctx.index + 1) : String(ctx.index + 1)));
    var main = div("dc-section-main");
    main.appendChild(div("dc-kicker", "Section"));
    main.appendChild(titleBlock("dc-section-title", s.title || ""));
    main.appendChild(div("dc-rule dc-rule--short"));
    if (s.subtitle) main.appendChild(tag("p", "dc-section-sub", s.subtitle));
    else if (s.bullets.length) main.appendChild(tag("p", "dc-section-sub", s.bullets.join("  ·  ")));
    main.appendChild(div("dc-section-strip"));
    body.appendChild(main);
    cv.appendChild(body);
    chrome(cv, ctx);
  };

  LAYOUTS.bullets = function (cv, s, ctx) {
    decorFor(cv, ctx);
    var body = div("dc-body dc-bullets");
    if (!s.bullets.length) {
      body.classList.add("dc-bullets--solo");
      body.appendChild(div("dc-kicker", ctx.total ? pad(ctx.index + 1) + " / " + pad(ctx.total) : ""));
      body.appendChild(titleBlock("dc-bullets-solo-title", s.title || ""));
      body.appendChild(div("dc-rule"));
      if (s.subtitle) body.appendChild(tag("p", "dc-bullets-sub", s.subtitle));
      cv.appendChild(body);
      chrome(cv, ctx);
      return;
    }
    body.appendChild(div("dc-kicker", s.subtitle ? s.subtitle.toUpperCase() : "Key points"));
    body.appendChild(titleBlock("dc-bullets-title", s.title || ""));
    body.appendChild(div("dc-rule dc-rule--short"));
    var cols = s.bullets.length > 4 ? 2 : 1;
    var ul = tag("ul", "dc-bullet-list" + (cols === 2 ? " is-cols2" : ""));
    s.bullets.forEach(function (b, i) {
      var li = tag("li", "dc-bullet");
      li.appendChild(span("dc-bullet-chip", cols === 2 ? pad(i + 1) : "\u25AA"));
      li.appendChild(span("dc-bullet-text", b));
      ul.appendChild(li);
    });
    body.appendChild(ul);
    cv.appendChild(body);
    chrome(cv, ctx);
  };

  LAYOUTS.split = function (cv, s, ctx) {
    decorFor(cv, ctx);
    var body = div("dc-body dc-split");
    var left = div("dc-split-left");
    left.appendChild(div("dc-kicker", "Overview"));
    left.appendChild(titleBlock("dc-split-title", s.title || ""));
    left.appendChild(div("dc-rule dc-rule--short"));
    if (s.subtitle) left.appendChild(tag("p", "dc-split-sub", s.subtitle));
    if (s.bullets.length) {
      var ul = tag("ul", "dc-split-points");
      s.bullets.slice(0, 5).forEach(function (b) {
        var li = tag("li");
        li.appendChild(span("dc-split-dot"));
        li.appendChild(span(null, b));
        ul.appendChild(li);
      });
      left.appendChild(ul);
    }
    var right = div("dc-split-right");
    var accentBlock = div("dc-split-accent");
    right.appendChild(accentBlock);
    right.appendChild(mediaBlock(s, ctx, "dc-split-media"));
    body.appendChild(left);
    body.appendChild(right);
    cv.appendChild(body);
    chrome(cv, ctx);
  };

  LAYOUTS.image = function (cv, s, ctx) {
    var full = div("dc-fullmedia");
    full.appendChild(mediaBlock(s, ctx, "dc-fullmedia-inner"));
    cv.appendChild(full);
    cv.appendChild(div("dc-scrim"));
    var body = div("dc-body dc-image");
    body.appendChild(div("dc-kicker", ctx.total ? pad(ctx.index + 1) + " / " + pad(ctx.total) : ""));
    body.appendChild(titleBlock("dc-image-title", s.title || s.image && s.image.query || ""));
    if (s.subtitle) body.appendChild(tag("p", "dc-image-sub", s.subtitle));
    if (s.bullets.length) {
      var chips = div("dc-chips");
      s.bullets.slice(0, 3).forEach(function (b) { chips.appendChild(span("dc-chip dc-chip--onimage", b)); });
      body.appendChild(chips);
    }
    cv.appendChild(body);
    chrome(cv, ctx);
  };

  LAYOUTS.quote = function (cv, s, ctx) {
    decorFor(cv, ctx);
    var q = s.quote || {};
    var text = q.text || s.bullets[0] || s.title || "";
    var attr = q.attribution || (q.text ? s.title : "") || "";
    var body = div("dc-body dc-quote");
    var mark = div("dc-quote-mark");
    mark.innerHTML = ICONS.quote;
    body.appendChild(mark);
    body.appendChild(tag("blockquote", "dc-quote-text" + (text.length > 160 ? " is-long" : ""), text));
    if (attr) {
      var by = div("dc-quote-by");
      by.appendChild(span("dc-quote-line"));
      by.appendChild(span("dc-quote-attr", attr));
      body.appendChild(by);
    }
    cv.appendChild(body);
    chrome(cv, ctx);
  };

  LAYOUTS.stats = function (cv, s, ctx) {
    decorFor(cv, ctx);
    var stats = s.stats.slice(0, 4);
    if (!stats.length && s.bullets.length) {
      stats = s.bullets.slice(0, 3).map(function (b) {
        var words = b.split(/\s+/);
        return { value: words.slice(0, 2).join(" "), label: words.slice(2).join(" ") || b };
      });
    }
    var body = div("dc-body dc-stats");
    body.appendChild(div("dc-kicker", "By the numbers"));
    body.appendChild(titleBlock("dc-stats-title", s.title || ""));
    if (stats.length) {
      var grid = div("dc-stats-grid dc-stats-grid--" + Math.min(stats.length, 4));
      stats.forEach(function (st, i) {
        var card = div("dc-stat-card" + (i % 2 ? " dc-stat-card--alt" : ""));
        card.appendChild(div("dc-stat-index", pad(i + 1)));
        card.appendChild(div("dc-stat-value", st.value));
        if (st.label) card.appendChild(div("dc-stat-label", st.label));
        grid.appendChild(card);
      });
      body.appendChild(grid);
    } else {
      body.appendChild(div("dc-rule"));
      body.appendChild(tag("p", "dc-stats-sub", s.subtitle || ""));
    }
    cv.appendChild(body);
    chrome(cv, ctx);
  };

  LAYOUTS.timeline = function (cv, s, ctx) {
    decorFor(cv, ctx);
    var items = s.timeline.slice(0, 6);
    if (!items.length) {
      if (s.bullets.length) { LAYOUTS.bullets(cv, s, ctx); return; }
      items = [{ when: "", what: s.subtitle || s.title }];
    }
    var body = div("dc-body dc-timeline");
    body.appendChild(div("dc-kicker", "Timeline"));
    body.appendChild(titleBlock("dc-timeline-title", s.title || ""));
    var horizontal = items.length <= 4;
    var list = tag("ol", "dc-timeline-list" + (horizontal ? " is-h" : " is-v"));
    items.forEach(function (it, i) {
      var li = tag("li", "dc-timeline-item");
      li.appendChild(div("dc-timeline-when", it.when));
      var nodeCol = div("dc-timeline-nodecol");
      nodeCol.appendChild(span("dc-timeline-node", String(i + 1)));
      nodeCol.appendChild(span("dc-timeline-rail"));
      li.appendChild(nodeCol);
      li.appendChild(div("dc-timeline-what", it.what));
      list.appendChild(li);
    });
    body.appendChild(list);
    cv.appendChild(body);
    chrome(cv, ctx);
  };

  LAYOUTS.comparison = function (cv, s, ctx) {
    decorFor(cv, ctx);
    var cmp = s.compare;
    if (!cmp && s.bullets.length) {
      var half = Math.ceil(s.bullets.length / 2);
      cmp = {
        left: { title: s.subtitle || "Option A", points: s.bullets.slice(0, half) },
        right: { title: "Option B", points: s.bullets.slice(half) }
      };
    }
    cmp = cmp || { left: { title: "", points: [] }, right: { title: "", points: [] } };
    var body = div("dc-body dc-compare");
    body.appendChild(div("dc-kicker", "Comparison"));
    body.appendChild(titleBlock("dc-compare-title", s.title || ""));
    var grid = div("dc-compare-grid");
    [["left", cmp.left, "cross"], ["right", cmp.right, "check"]].forEach(function (spec) {
      var side = spec[0], data = spec[1], ic = spec[2];
      var card = div("dc-compare-card dc-compare-card--" + side);
      var head = div("dc-compare-head");
      head.appendChild(div("dc-compare-heading", data.title || (side === "left" ? "Option A" : "Option B")));
      card.appendChild(head);
      var ul = tag("ul", "dc-compare-points");
      data.points.forEach(function (p) {
        var li = tag("li");
        li.appendChild(icon(null, ic, "dc-compare-ic"));
        li.appendChild(span(null, p));
        ul.appendChild(li);
      });
      card.appendChild(ul);
      grid.appendChild(card);
      if (side === "left") grid.appendChild(div("dc-compare-vs", "VS"));
    });
    body.appendChild(grid);
    cv.appendChild(body);
    chrome(cv, ctx);
  };

  LAYOUTS.compose = function (cv, s, ctx) {
    decorFor(cv, ctx);
    var body = div("dc-body dc-compose");
    var blocks = (s.blocks && s.blocks.length) ? s.blocks : [];
    var hasTitleBlock = blocks.some(function (b) { return b.type === "title"; });
    if (s.title && !hasTitleBlock) body.appendChild(titleBlock("dc-heading", s.title, { h: "h2" }));
    var grid = div("dc-grid");
    blocks.forEach(function (b) {
      var el = null;
      if (b.type === "kicker") el = div("dc-kicker", asText(b.text).toUpperCase());
      else if (b.type === "title") el = tag((b.size === "xl" || b.size === "l") ? "h2" : "h3", "dc-blk-title", b.text);
      else if (b.type === "text") el = tag("p", "dc-blk-text", b.text);
      else if (b.type === "callout") el = div("dc-blk-callout", b.text);
      else if (b.type === "quote") {
        el = tag("blockquote", "dc-blk-quote", b.text);
        if (b.attribution) el.appendChild(span("dc-blk-attr", b.attribution));
      } else if (b.type === "chips") {
        el = div("dc-chips");
        b.items.forEach(function (item) { el.appendChild(span("dc-chip", item)); });
      } else if (b.type === "stat") {
        el = div("dc-blk-stat");
        el.appendChild(div("dc-blk-stat-value", b.value));
        el.appendChild(div("dc-blk-stat-label", b.label));
      } else if (b.type === "stats") {
        el = div("dc-blk-statgrid");
        b.items.forEach(function (item) {
          var card = div("dc-blk-statcard");
          card.appendChild(div("dc-blk-stat-value", item.value));
          card.appendChild(div("dc-blk-stat-label", item.label));
          el.appendChild(card);
        });
      } else if (b.type === "list") {
        el = tag(b.numbered ? "ol" : "ul", "dc-blk-list");
        b.items.forEach(function (item) { el.appendChild(tag("li", null, item)); });
        if (b.columns === 2) el.classList.add("is-two-col");
      } else if (b.type === "divider") {
        el = div("dc-rule");
      } else if (b.type === "spacer") {
        el = div("dc-blk-spacer");
      }
      if (!el) return;
      var extra = "dc-blk dc-blk--" + b.type;
      if (b.size) extra += " is-" + b.size;
      if (b.align) extra += " is-" + b.align;
      el.className = (el.className ? el.className + " " : "") + extra;
      if (b.span) el.style.gridColumn = "span " + b.span;
      grid.appendChild(el);
    });
    body.appendChild(grid);
    cv.appendChild(body);
    chrome(cv, ctx);
  };

  LAYOUTS.closing = function (cv, s, ctx) {
    var t = ctx.theme;
    cv.style.setProperty("--d-bg", "#" + (t.dark ? mix(t.bg, "#000000", 0.35) : t.ink));
    cv.style.setProperty("--d-ink", t.dark ? "#" + t.ink : "#" + (t.dark ? "FFFFFF" : mix(t.bg, "#FFFFFF", 0.85)));
    cv.classList.add("dc--closing-dark");
    decorFor(cv, ctx);
    var body = div("dc-body dc-closing");
    body.appendChild(div("dc-kicker", "Thank you"));
    body.appendChild(titleBlock("dc-closing-title", s.title || "Let\u2019s make it happen", { h: "h2" }));
    if (s.subtitle) body.appendChild(tag("p", "dc-closing-sub", s.subtitle));
    var cta = s.bullets[0] || (s.quote && s.quote.text) || "";
    var ctaRow = div("dc-closing-cta");
    ctaRow.appendChild(span("dc-closing-pill", cta || "Questions?"));
    var arrow = icon(null, "arrow", "dc-closing-arrow");
    ctaRow.appendChild(arrow);
    body.appendChild(ctaRow);
    if (s.bullets.length > 1) {
      var more = div("dc-closing-more");
      s.bullets.slice(1, 4).forEach(function (b) { more.appendChild(span("dc-chip dc-chip--onimage", b)); });
      body.appendChild(more);
    }
    cv.appendChild(body);
  };

  /* ------------------------------------------------------------------ public */

  function renderSlideCanvas(rawSlide, index, ctx) {
    ctx = ctx || {};
    var theme = normalizeTheme(ctx.theme || {});
    var slide = normalizeSlide(rawSlide);
    var total = ctx.total || 0;
    var layout = resolveLayout(slide, index, total);
    var seed = theme.seed;
    var cv = tag("article", "dc dc--" + (theme.dark ? "dark" : "light") + " dc--" + layout + (index % 2 ? " dc--alt" : ""));
    cv.setAttribute("data-layout", layout);
    var vars = themeVars(theme);
    Object.keys(vars).forEach(function (k) { cv.style.setProperty(k, vars[k]); });
    var ctx2 = {
      theme: theme,
      index: index,
      total: total,
      deckTitle: ctx.deckTitle || "",
      subtitle: ctx.subtitle || "",
      seed: seed,
      uid: "u" + (seed % 99991) + "n" + index,
      motif: theme.motif,
      layout: layout
    };
    LAYOUTS[layout](cv, slide, ctx2);
    return cv;
  }

  var observer = null;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) applyScale(entries[i].target);
    });
  }

  function applyScale(frame) {
    var w = frame.clientWidth || frame.getBoundingClientRect().width;
    if (!w) return;
    var s = Math.round((w / DESIGN_W) * 100000) / 100000;
    frame.style.setProperty("--scale", String(s));
  }

  function observeFrame(frame) {
    if (observer) observer.observe(frame);
    else {
      applyScale(frame);
      window.addEventListener("resize", function () { applyScale(frame); });
    }
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(function () { applyScale(frame); });
  }

  function slideCard(rawSlide, index, ctx) {
    ctx = ctx || {};
    var frame = tag("div", "slide-frame" + (ctx.frameClass ? " " + ctx.frameClass : ""));
    var cv = renderSlideCanvas(rawSlide, index, ctx);
    frame.appendChild(cv);
    frame.addEventListener("click", function () {
      if (typeof ctx.onClick === "function") ctx.onClick(index, frame);
    });
    observeFrame(frame);
    return frame;
  }

  function renderDeck(container, deck, ctx) {
    if (!container) return;
    ctx = ctx || {};
    var theme = normalizeTheme((deck && deck.theme) || (ctx.theme) || {});
    var slides = (deck && Array.isArray(deck.slides)) ? deck.slides : [];
    container.innerHTML = "";
    slides.forEach(function (s, i) {
      container.appendChild(slideCard(s, i, {
        theme: theme,
        total: slides.length,
        deckTitle: (deck && deck.title) || ctx.deckTitle || "",
        frameClass: ctx.frameClass,
        onClick: ctx.onClick
      }));
    });
    return theme;
  }

  window.ZDeck = {
    version: "3.0",
    design: { width: DESIGN_W, height: DESIGN_H },
    normalizeTheme: normalizeTheme,
    normalizeSlide: normalizeSlide,
    resolveLayout: resolveLayout,
    renderSlideCanvas: renderSlideCanvas,
    slideCard: slideCard,
    renderDeck: renderDeck,
    layouts: LAYOUT_NAMES.slice()
  };
})();
