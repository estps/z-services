const { app, BrowserWindow, session, shell } = require("electron");

const APP_URL = "https://z-chat.men";
const UA_SUFFIX = " ZChatDesktopMac/1.0";

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 380,
    minHeight: 520,
    title: "Z Chat",
    backgroundColor: "#0b0d12",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setUserAgent(win.webContents.getUserAgent() + UA_SUFFIX);
  win.loadURL(APP_URL);

  // External links open in the default browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(APP_URL)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(APP_URL) || url.startsWith("https://accounts.google.com") || url.startsWith("https://login.microsoftonline.com") || url.includes(".supabase.co")) {
      return;
    }
    event.preventDefault();
    shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  // Allow calls (camera/mic) and notifications.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(["media", "audioCapture", "videoCapture", "notifications"].includes(permission));
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
