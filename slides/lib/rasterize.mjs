/* Render a free-form HTML slide to a PNG (headless Chrome) so the PPTX/Canva
   export matches the on-screen design. Text disappears in the image, but the
   exact design is preserved. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cachedChrome = null;

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const roots = [
    "/srv/zsparx/.cache/selenium/chrome",
    "/root/.cache/selenium/chrome",
    "/root/.claude-server-commander/puppeteer-cache/chrome",
  ];
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      const versions = fs.readdirSync(root).sort().reverse();
      for (const version of versions) {
        for (const candidate of [
          path.join(root, version, "chrome"),
          path.join(root, version, "chrome-linux64", "chrome"),
        ]) {
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch {
      /* keep looking */
    }
  }
  for (const direct of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (fs.existsSync(direct)) return direct;
  }
  return "";
}

export function renderSlidePng(html, theme, { width = 1280, height = 720 } = {}) {
  if (cachedChrome === null) cachedChrome = findChrome();
  if (!cachedChrome) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zsx-"));
  const bg = (theme && theme.bg) || "111111";
  const doc =
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:#${bg}}` +
    `</style></head><body>${html}</body></html>`;
  const htmlFile = path.join(tmp, "slide.html");
  const pngFile = path.join(tmp, "slide.png");
  fs.writeFileSync(htmlFile, doc);
  try {
    spawnSync(
      cachedChrome,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        `--user-data-dir=${path.join(tmp, "prof")}`,
        `--window-size=${width},${height}`,
        `--screenshot=${pngFile}`,
        "--virtual-time-budget=5000",
        "file://" + htmlFile,
      ],
      { timeout: 30000 },
    );
    if (!fs.existsSync(pngFile)) return null;
    return "data:image/png;base64," + fs.readFileSync(pngFile).toString("base64");
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
