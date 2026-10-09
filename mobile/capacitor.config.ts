import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Z Chat iOS shell.
 *
 * `server.url` makes the native app load the live production site in its
 * WebView. Every web deploy therefore updates the app instantly - no App
 * Store release is needed for content or feature changes. Only changes to
 * the native shell itself (plugins, permissions, splash screen, store
 * metadata) require a new binary + review.
 */
const config: CapacitorConfig = {
  appId: "men.zchat.app",
  appName: "Z Chat",
  // Placeholder web assets only. Never displayed because `server.url` takes
  // over on launch; it must still exist for `cap sync` / `cap add ios`.
  webDir: "www",
  server: {
    url: "https://z-chat.men",
    cleartext: false,
  },
};

export default config;
