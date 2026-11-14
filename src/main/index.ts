import { app, BrowserWindow, session, type WebContents } from "electron";
import path from "path";
import { registerIpcHandlers, shutdownIpcServices } from "./ipc-handlers";
import { settingsStore } from "./services/settings-store";
import { TraceWriter } from "./services/trace-writer";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require("electron-squirrel-startup")) {
  app.quit();
}

// Declare webpack globals injected by @electron-forge/plugin-webpack
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

const trustedWebContentsIds = new Set<number>();
let shutdownStarted = false;
let shutdownComplete = false;
// 実行の記録を userData/traces に保存する。本文や検索語は記録に含まれない。
let traceWriter: TraceWriter | null = null;

const isAllowedSessionPermission = (webContents: WebContents | null, permission: string): boolean =>
  webContents !== null &&
  trustedWebContentsIds.has(webContents.id) &&
  permission === "clipboard-sanitized-write";

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      // セキュリティ設定（CLAUDE.md §Security 準拠）
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });

  const webContentsId = mainWindow.webContents.id;
  trustedWebContentsIds.add(webContentsId);
  mainWindow.on("closed", () => trustedWebContentsIds.delete(webContentsId));

  // Renderer 由来のURLをElectron内で開かず、外部遷移は検証済みIPCだけに限定する。
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());

  void mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY).catch(() => {
    console.error("[App] Failed to load the renderer");
  });

  // 開発時のみ DevTools を有効化
  if (!app.isPackaged && process.env.NODE_ENV === "development") {
    mainWindow.webContents.openDevTools();
  }
};

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler((webContents, permission) =>
    isAllowedSessionPermission(webContents, permission)
  );
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(isAllowedSessionPermission(webContents, permission));
  });

  try {
    await settingsStore.init();
  } catch {
    // 既存ファイルを上書きせず、このセッションだけ既定値で継続する。
    console.error("[SettingsStore] Initialization failed; using in-memory defaults");
    settingsStore.useDefaultsInMemory();
  }
  traceWriter = new TraceWriter({ directory: path.join(app.getPath("userData"), "traces") });
  registerIpcHandlers({
    isTrustedSender: (webContentsId) => trustedWebContentsIds.has(webContentsId),
    traceSinks: [traceWriter.sink],
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;

  shutdownStarted = true;
  void shutdownIpcServices()
    .catch(() => {
      console.warn("[App] MCP shutdown did not complete cleanly");
    })
    // キャンセルされた実行の最後の行まで書き終えてから終了する。
    .then(() => traceWriter?.flush())
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});
