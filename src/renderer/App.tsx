import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChatView } from "./components/ChatView";
import { ChatInput } from "./components/ChatInput";
import { StatusBar } from "./components/StatusBar";
import { SettingsView } from "./components/SettingsView";
import { completionNoticeText } from "./completion-notice";
import type { ChatTurn, MaterialContextSummary } from "../shared/types/chat";
import { CHAT_MODEL, type McpConnectionState } from "../shared/types/settings";
import "./index.css";

/** 現在表示中のビュー */
type ViewType = "chat" | "settings";

interface UiNotice {
  type: "info" | "error";
  text: string;
}

const INITIAL_MCP_CONNECTION: McpConnectionState = { status: "disconnected" };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [materialContext, setMaterialContext] = useState<MaterialContextSummary[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [mcpConnection, setMcpConnection] = useState<McpConnectionState>(INITIAL_MCP_CONNECTION);
  const [modelName, setModelName] = useState(CHAT_MODEL);
  const [currentView, setCurrentView] = useState<ViewType>("chat");
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [inputResetToken, setInputResetToken] = useState(0);
  const [notice, setNotice] = useState<UiNotice | null>(null);
  const [isDataMenuOpen, setIsDataMenuOpen] = useState(false);
  const cancelRequestedRef = useRef(false);
  const receivedMcpStatusRef = useRef(false);
  const dataMenuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    document.documentElement.className = `theme-${theme}`;
  }, [theme]);

  useEffect(() => {
    if (!isDataMenuOpen) return;

    const closeMenu = (restoreFocus: boolean) => {
      const menu = dataMenuRef.current;
      if (!menu) return;
      menu.open = false;
      setIsDataMenuOpen(false);
      if (restoreFocus) menu.querySelector<HTMLElement>("summary")?.focus();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const menu = dataMenuRef.current;
      if (menu && event.target instanceof Node && !menu.contains(event.target)) {
        closeMenu(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu(true);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDataMenuOpen]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const refreshMaterialContext = useCallback(async () => {
    try {
      const materials = await window.electronAPI.getMaterialContext();
      setMaterialContext(materials);
    } catch (error) {
      setNotice({
        type: "error",
        text: `資料コンテキストを取得できませんでした: ${describeError(error)}`,
      });
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    const cleanup = window.electronAPI.onMcpStatusChange((connection) => {
      if (!disposed) {
        receivedMcpStatusRef.current = true;
        setMcpConnection(connection);
        setIsReconnecting(false);
      }
    });

    const hydrate = async () => {
      const [statusResult, historyResult, materialsResult] = await Promise.allSettled([
        window.electronAPI.getStatus(),
        window.electronAPI.getChatHistory(),
        window.electronAPI.getMaterialContext(),
      ]);

      if (disposed) return;

      if (statusResult.status === "fulfilled") {
        if (!receivedMcpStatusRef.current) {
          setMcpConnection(statusResult.value.mcpConnection);
        }
        setModelName(statusResult.value.model);
      } else if (!receivedMcpStatusRef.current) {
        setMcpConnection({
          status: "error",
          error: {
            code: "UNKNOWN",
            message: "MCP接続状態を取得できませんでした。",
            guidance: "アプリを再起動するか、再接続をお試しください。",
            retryable: true,
          },
        });
      }

      const hydrationErrors: string[] = [];
      if (historyResult.status === "fulfilled") {
        setMessages(historyResult.value);
      } else {
        hydrationErrors.push(
          `会話履歴を取得できませんでした: ${describeError(historyResult.reason)}`
        );
      }

      if (materialsResult.status === "fulfilled") {
        setMaterialContext(materialsResult.value);
      } else {
        hydrationErrors.push(
          `資料コンテキストを取得できませんでした: ${describeError(materialsResult.reason)}`
        );
      }
      if (hydrationErrors.length > 0) {
        setNotice({
          type: "error",
          text: hydrationErrors.join(" / "),
        });
      }
      setIsHydrated(true);
    };

    void hydrate();

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  /** ビュー切替 */
  const switchView = (target: ViewType) => {
    if (target === currentView) return;
    setIsDataMenuOpen(false);
    setCurrentView(target);
  };

  const closeSettings = async () => {
    switchView("chat");
    try {
      const status = await window.electronAPI.getStatus();
      setMcpConnection(status.mcpConnection);
      setModelName(status.model);
    } catch {
      // StatusBar の最新イベント状態を維持する。
    }
  };

  const handleSend = async (text: string) => {
    if (!isHydrated) return;
    const newUserMsg: ChatTurn = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, newUserMsg]);
    setNotice(null);
    setIsLoading(true);
    setIsCancelling(false);
    cancelRequestedRef.current = false;

    try {
      const response = await window.electronAPI.sendChat(text);

      const newAiMsg: ChatTurn = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: response.content,
        citations: response.citations,
        timestamp: new Date().toISOString(),
      };
      try {
        setMessages(await window.electronAPI.getChatHistory());
      } catch {
        // Main の上限と同じ200件に抑え、同期失敗時も表示だけが無制限に増えないようにする。
        setMessages((previous) => [...previous, newAiMsg].slice(-200));
      }
      const incompleteNotice = completionNoticeText(response.completion);
      if (incompleteNotice) setNotice({ type: "info", text: incompleteNotice });
      await refreshMaterialContext();
    } catch (error) {
      const errMsg = describeError(error);
      const wasCancelled = cancelRequestedRef.current || getErrorCode(error) === "CHAT_CANCELLED";

      try {
        setMessages(await window.electronAPI.getChatHistory());
      } catch {
        setMessages((previous) => previous.filter((message) => message.id !== newUserMsg.id));
      }

      if (wasCancelled) {
        setNotice({ type: "info", text: "回答の生成をキャンセルしました。" });
      } else {
        setNotice({ type: "error", text: `回答を生成できませんでした: ${errMsg}` });
      }
    } finally {
      cancelRequestedRef.current = false;
      setIsCancelling(false);
      setIsLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!isLoading || isCancelling) return;
    cancelRequestedRef.current = true;
    setIsCancelling(true);
    try {
      await window.electronAPI.cancelChat();
    } catch (error) {
      cancelRequestedRef.current = false;
      setNotice({
        type: "error",
        text: `キャンセルできませんでした: ${describeError(error)}`,
      });
      setIsCancelling(false);
    }
  };

  const handleReconnect = async () => {
    if (isReconnecting || mcpConnection.status === "connecting") return;
    setIsReconnecting(true);
    setNotice(null);
    setMcpConnection((previous) => ({ ...previous, status: "reconnecting", error: undefined }));

    try {
      const result = await window.electronAPI.reconnectMcp();
      if (!result.success) {
        setNotice({
          type: "error",
          text: [result.error ?? "MCPへの再接続に失敗しました。", result.guidance]
            .filter(Boolean)
            .join(" "),
        });
      }

      const status = await window.electronAPI.getStatus();
      setMcpConnection(status.mcpConnection);
    } catch (error) {
      setNotice({
        type: "error",
        text: `MCPへの再接続に失敗しました: ${describeError(error)}`,
      });
      setMcpConnection((previous) => ({ ...previous, status: "error" }));
    } finally {
      setIsReconnecting(false);
    }
  };

  const handleStartNewChat = async () => {
    if (!isHydrated || isLoading) return;
    if (
      messages.length > 0 &&
      !window.confirm(
        "新しい会話を開始しますか？\n現在の会話表示は空になりますが、参照した資料は保持されます。"
      )
    ) {
      return;
    }

    try {
      await window.electronAPI.startNewChat();
      setMessages([]);
      setInputResetToken((value) => value + 1);
      setNotice({
        type: "info",
        text: "新しい会話を開始しました。参照した資料は引き続き利用できます。",
      });
    } catch (error) {
      setNotice({
        type: "error",
        text: `新しい会話を開始できませんでした: ${describeError(error)}`,
      });
    }
  };

  const handleClearHistory = async () => {
    if (!isHydrated || isLoading || messages.length === 0) return;
    if (
      !window.confirm(
        "会話履歴を削除しますか？\nこの操作は取り消せません。資料コンテキストは削除されません。"
      )
    ) {
      return;
    }

    try {
      await window.electronAPI.clearHistory();
      setMessages([]);
      setInputResetToken((value) => value + 1);
      setNotice({ type: "info", text: "会話履歴を削除しました。" });
    } catch (error) {
      setNotice({
        type: "error",
        text: `会話履歴を削除できませんでした: ${describeError(error)}`,
      });
    }
  };

  const handleClearMaterialContext = async () => {
    if (!isHydrated || isLoading || materialContext.length === 0) return;
    if (
      !window.confirm(
        `参照した資料 ${materialContext.length}件を削除しますか？\nこの操作は取り消せません。会話履歴は削除されません。`
      )
    ) {
      return;
    }

    try {
      await window.electronAPI.clearMaterialContext();
      setMaterialContext([]);
      setNotice({ type: "info", text: "資料コンテキストを削除しました。" });
    } catch (error) {
      setNotice({
        type: "error",
        text: `資料コンテキストを削除できませんでした: ${describeError(error)}`,
      });
    }
  };

  const isChat = currentView === "chat";

  return (
    <div className="app">
      <header className="app-header">
        {isChat ? (
          <>
            <h1>INIAD AI Chat</h1>
            <div className="header-actions">
              <button
                type="button"
                className="header-action-button"
                onClick={() => void handleStartNewChat()}
                disabled={!isHydrated || isLoading}
              >
                新しい会話
              </button>
              <details
                ref={dataMenuRef}
                className="data-menu"
                onToggle={(event) => setIsDataMenuOpen(event.currentTarget.open)}
              >
                <summary className="header-action-button">
                  履歴・資料
                  <span
                    className="material-count-badge"
                    aria-label={`資料 ${materialContext.length}件`}
                  >
                    {materialContext.length}
                  </span>
                </summary>
                <div className="data-menu-panel">
                  <div className="data-menu-summary">
                    会話 {messages.length}件 / 資料 {materialContext.length}件
                  </div>
                  <button
                    type="button"
                    className="data-menu-action danger"
                    onClick={() => void handleClearHistory()}
                    disabled={!isHydrated || isLoading || messages.length === 0}
                  >
                    会話履歴を削除
                  </button>
                  <button
                    type="button"
                    className="data-menu-action danger"
                    onClick={() => void handleClearMaterialContext()}
                    disabled={!isHydrated || isLoading || materialContext.length === 0}
                  >
                    資料コンテキストを削除
                  </button>
                </div>
              </details>
              <button
                className="theme-toggle-btn"
                onClick={toggleTheme}
                aria-label="テーマ切替"
                title="テーマ切替"
              >
                {theme === "light" ? (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
                  </svg>
                ) : (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="5"></circle>
                    <line x1="12" y1="1" x2="12" y2="3"></line>
                    <line x1="12" y1="21" x2="12" y2="23"></line>
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                    <line x1="1" y1="12" x2="3" y2="12"></line>
                    <line x1="21" y1="12" x2="23" y2="12"></line>
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
                  </svg>
                )}
              </button>
              <button
                className="settings-button"
                onClick={() => switchView("settings")}
                aria-label="設定を開く"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z" />
                </svg>{" "}
                設定
              </button>
            </div>
          </>
        ) : (
          <>
            <h1>設定</h1>
            <button
              className="settings-button"
              onClick={() => void closeSettings()}
              aria-label="設定を閉じる"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </>
        )}
      </header>

      {notice && (
        <div
          className={`app-notice ${notice.type}`}
          role={notice.type === "error" ? "alert" : "status"}
        >
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="通知を閉じる">
            ×
          </button>
        </div>
      )}

      {/* 両ビューをコンテナ内に絶対配置し、スムーズにトランジション */}
      <div className="views-container">
        <div className={`view-layer ${isChat ? "view-active" : "view-hidden"}`}>
          <main className="app-main">
            <ChatView messages={messages} isLoading={isLoading} />
          </main>
          <ChatInput
            key={inputResetToken}
            onSend={handleSend}
            onCancel={() => void handleCancel()}
            isLoading={isLoading}
            isCancelling={isCancelling}
            disabled={!isHydrated}
          />
        </div>

        <div className={`view-layer ${!isChat ? "view-active" : "view-hidden"}`}>
          <main className="app-main">
            <SettingsView onClose={() => void closeSettings()} />
          </main>
        </div>
      </div>

      <StatusBar
        connection={mcpConnection}
        model={modelName}
        materialCount={materialContext.length}
        onReconnect={() => void handleReconnect()}
        isReconnecting={isReconnecting}
      />
    </div>
  );
};

export default App;
