/**
 * Renderer プロセス用の window.electronAPI 型拡張
 *
 * preload.ts で contextBridge.exposeInMainWorld("electronAPI", ...)
 * により公開される API の型定義。
 * Renderer 側で window.electronAPI を使うと自動的に型補完が効く。
 */
import type {
  ChatProgress,
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

export interface ElectronAPI {
  // ── チャット操作 ──
  sendChat: (userText: string) => Promise<ChatResponse>;
  cancelChat: () => Promise<void>;

  // ── 会話履歴 ──
  getChatHistory: () => Promise<ChatTurn[]>;
  clearHistory: () => Promise<void>;
  startNewChat: () => Promise<void>;
  getMaterialContext: () => Promise<MaterialContextSummary[]>;
  clearMaterialContext: () => Promise<void>;

  // ── ステータス ──
  getStatus: () => Promise<AppStatus>;

  // ── 設定 ──
  getSettings: () => Promise<PublicAppSettings>;
  saveSettings: (settings: PartialAppSettings) => Promise<void>;
  testMcpConnection: (input: McpCredentialTestInput) => Promise<ConnectionTestResult>;
  reconnectMcp: () => Promise<ConnectionTestResult>;
  openExternalUrl: (url: string) => Promise<boolean>;

  // ── イベントリスナ ──
  onChatProgress: (callback: (progress: ChatProgress) => void) => () => void;
  onMcpStatusChange: (callback: (status: McpConnectionState) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
