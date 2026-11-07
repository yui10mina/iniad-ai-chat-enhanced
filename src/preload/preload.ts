/**
 * Preload スクリプト — contextBridge による安全な IPC 橋渡し
 *
 * Renderer プロセスから Main プロセスへの通信を、
 * contextBridge.exposeInMainWorld 経由で型安全に公開する。
 * Renderer は window.electronAPI を通じてのみ Main と通信する。
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  ChatResponse,
  ChatTurn,
  PublicAppSettings,
  AppStatus,
  PartialAppSettings,
  ConnectionTestResult,
  McpConnectionState,
  McpCredentialTestInput,
  MaterialContextSummary,
} from "../shared/types";

const api = {
  // ── チャット操作 ──
  /** ユーザーメッセージを送信し、AIの回答を取得する */
  sendChat: (userText: string): Promise<ChatResponse> => ipcRenderer.invoke("chat:send", userText),

  /** 送信中のチャットをキャンセルする */
  cancelChat: (): Promise<void> => ipcRenderer.invoke("chat:cancel"),

  // ── 会話履歴 ──
  /** セッション内の会話履歴を取得する */
  getChatHistory: (): Promise<ChatTurn[]> => ipcRenderer.invoke("chat:list"),

  /** 会話履歴をクリアする */
  clearHistory: (): Promise<void> => ipcRenderer.invoke("chat:clear"),

  /** 現在の会話だけを終了し、資料コンテキストは保持して新しい会話を始める */
  startNewChat: (): Promise<void> => ipcRenderer.invoke("chat:new"),

  /** Main 内に保持している資料コンテキストの概要を取得する */
  getMaterialContext: (): Promise<MaterialContextSummary[]> => ipcRenderer.invoke("context:list"),

  /** 資料コンテキストだけを削除する */
  clearMaterialContext: (): Promise<void> => ipcRenderer.invoke("context:clear"),

  // ── ステータス ──
  /** アプリケーションの現在の状態を取得する */
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke("app:status"),

  // ── 設定 ──
  /** 設定値を取得する（機密値は空文字列・設定済みフラグで示す） */
  getSettings: (): Promise<PublicAppSettings> => ipcRenderer.invoke("settings:get"),

  /** 設定値を部分更新する（空文字列は既存値を維持） */
  saveSettings: (settings: PartialAppSettings): Promise<void> =>
    ipcRenderer.invoke("settings:set", settings),

  /** MOOCs へのログインをテストする（入力値を渡すと、成功時だけ保存する） */
  testMcpConnection: (input: McpCredentialTestInput): Promise<ConnectionTestResult> =>
    ipcRenderer.invoke("settings:test-mcp", input),

  /** MCP をユーザー操作で再接続する */
  reconnectMcp: (): Promise<ConnectionTestResult> => ipcRenderer.invoke("mcp:reconnect"),

  /** 検証済みの HTTPS URL を OS の既定ブラウザーで開く */
  openExternalUrl: (url: string): Promise<boolean> => ipcRenderer.invoke("external:open", url),

  // ── イベントリスナ（Main→Renderer へのプッシュ通知） ──
  /** MCP 接続状態の変更を監視する（cleanup 関数を返す） */
  onMcpStatusChange: (callback: (status: McpConnectionState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: McpConnectionState) =>
      callback(status);
    ipcRenderer.on("mcp:status", handler);
    return () => {
      ipcRenderer.removeListener("mcp:status", handler);
    };
  },
};

// window.electronAPI として Renderer に公開
contextBridge.exposeInMainWorld("electronAPI", api);
