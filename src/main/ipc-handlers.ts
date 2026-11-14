/** Main プロセスでのみ実行する、検証済み IPC ハンドラー。 */
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { AppError, toSerializableError } from "../shared/types/errors";
import type { ChatResponse, ChatTurn } from "../shared/types/chat";
import { toAssistantTurn } from "../shared/utils/assistant-turn";
import type {
  ConnectionTestResult,
  McpConnectionState,
  McpCredentialTestInput,
} from "../shared/types/settings";
import {
  validateChatInput,
  validateExternalUrl,
  validateMcpCredentialTestInput,
  validateSettingsInput,
} from "./ipc-validation";
import { createAppServices } from "./services/app-services";
import type { MaterialContextInput } from "./services/in-memory-store";
import {
  AutomaticReconnectPolicy,
  disconnectMcp,
  ensureMcpConnected,
  type AutomaticReconnectDecision,
  type McpConnectionResult,
  type McpCredentials,
} from "./services/mcp-connection";
import { type McpClientError } from "./services/mcp-client";
import { testMcpCredentials } from "./services/mcp-credential-test";
import { settingsStore } from "./services/settings-store";

export interface RegisterIpcHandlersOptions {
  isTrustedSender: (webContentsId: number) => boolean;
}

type SecureHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>;

const services = createAppServices();
const { store, mcpClient, chatAgent } = services;

let handlersRegistered = false;
let activeController: AbortController | null = null;
let activeChatCompletion: Promise<void> | null = null;
let activeConnection: {
  controller: AbortController;
  promise: Promise<McpConnectionResult>;
} | null = null;
let credentialTestInFlight = false;
let removeConnectionIssueListener: (() => void) | null = null;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let mcpConnectionState: McpConnectionState = { status: "disconnected" };
const automaticReconnectPolicy = new AutomaticReconnectPolicy();
let automaticReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function broadcastMcpState(next: McpConnectionState): void {
  if (next.status === "connected") automaticReconnectPolicy.markConnected();
  else automaticReconnectPolicy.markUnstable();

  mcpConnectionState = {
    ...next,
    lastConnectedAt: next.lastConnectedAt ?? mcpConnectionState.lastConnectedAt,
  };
  store.setMcpConnectionState(mcpConnectionState);

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("mcp:status", { ...mcpConnectionState });
    }
  }
}

function secureHandle(
  channel: string,
  options: RegisterIpcHandlersOptions,
  handler: SecureHandler
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event, options);
    return handler(event, ...args);
  });
}

function secureNoArg(
  channel: string,
  options: RegisterIpcHandlersOptions,
  handler: (event: IpcMainInvokeEvent) => unknown | Promise<unknown>
): void {
  secureHandle(channel, options, (event, ...args) => {
    if (args.length !== 0) {
      throw new AppError("INVALID_INPUT", `IPC ${channel} does not accept arguments`);
    }
    return handler(event);
  });
}

function assertTrustedSender(event: IpcMainInvokeEvent, options: RegisterIpcHandlersOptions): void {
  const isMainFrame = event.senderFrame === event.sender.mainFrame;
  if (event.sender.isDestroyed() || !isMainFrame || !options.isTrustedSender(event.sender.id)) {
    throw new AppError("PERMISSION_DENIED", "この IPC 呼び出しは許可されていません");
  }
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  removeConnectionIssueListener = mcpClient.onConnectionIssue((error) => {
    handleMcpConnectionIssue(error);
  });

  secureHandle("chat:send", options, async (_event, rawText) => {
    const userText = validateChatInput(rawText);
    if (activeController) {
      throw new AppError("INVALID_INPUT", "別の回答を生成中です");
    }
    if (credentialTestInFlight) {
      throw new AppError("INVALID_INPUT", "MOOCs の接続テスト中です。終わってから送信してください");
    }

    const controller = new AbortController();
    activeController = controller;
    const task = runChat(userText, controller);
    const completion = task.then(
      () => undefined,
      () => undefined
    );
    activeChatCompletion = completion;

    try {
      return await task;
    } finally {
      if (activeController === controller) activeController = null;
      if (activeChatCompletion === completion) activeChatCompletion = null;
    }
  });

  secureNoArg("chat:cancel", options, async () => {
    await cancelActiveChat();
  });

  secureNoArg("chat:list", options, async () => store.getHistory());

  secureNoArg("chat:new", options, async () => {
    await cancelActiveChat();
    store.clearConversationHistory();
  });

  secureNoArg("chat:clear", options, async () => {
    await cancelActiveChat();
    store.clearConversationHistory();
  });

  secureNoArg("context:list", options, async () => store.getMaterialContextSummaries());

  secureNoArg("context:clear", options, async () => {
    await cancelActiveChat();
    store.clearMaterialContext();
  });

  secureNoArg("app:status", options, async () => {
    const settings = settingsStore.getRawSettings();
    store.setModel(settings.model);
    store.setHasApiKey(settingsStore.hasApiKey());
    return {
      ...store.getAppStatus(),
      mcpStatus: mcpConnectionState.status,
      mcpConnection: { ...mcpConnectionState },
    };
  });

  secureNoArg("settings:get", options, async () => settingsStore.getSettings());

  secureHandle("settings:set", options, async (_event, rawSettings) => {
    const partial = validateSettingsInput(rawSettings);
    const changesCredentials = "moocsUsername" in partial || "moocsPassword" in partial;
    if (changesCredentials && credentialTestInFlight) {
      throw new AppError("INVALID_INPUT", "MOOCs の接続テスト中は認証情報を保存できません");
    }
    await settingsStore.updateSettings(partial);

    if (partial.model) store.setModel(partial.model);
    store.setHasApiKey(settingsStore.hasApiKey());

    if (changesCredentials) {
      void reconnectAfterCredentialChange();
    }
  });

  secureHandle("settings:test-mcp", options, async (_event, rawInput) => {
    return runMcpCredentialTest(validateMcpCredentialTestInput(rawInput));
  });

  secureNoArg("mcp:reconnect", options, async () => {
    if (credentialTestInFlight) {
      return { success: false, error: "MOOCs の接続テスト中です" };
    }
    return toConnectionTestResult(await reconnectMcp());
  });

  secureHandle("external:open", options, async (_event, rawUrl) => {
    const url = validateExternalUrl(rawUrl);
    try {
      await shell.openExternal(url, { activate: true });
      return true;
    } catch {
      return false;
    }
  });

  // UI の描画や操作を待たず、起動直後にバックグラウンド接続を始める。
  void tryAutoConnectMcp();
}

async function runChat(userText: string, controller: AbortController): Promise<ChatResponse> {
  const settings = settingsStore.getRawSettings();
  const userMessage: ChatTurn = {
    id: `msg_${Date.now()}_user`,
    role: "user",
    content: userText,
    timestamp: new Date().toISOString(),
  };

  try {
    const shouldTryMcp =
      mcpClient.getStatus() !== "connected" &&
      settingsStore.hasMoocsCredentials() &&
      (mcpConnectionState.status !== "error" || mcpConnectionState.error?.retryable !== false);
    if (shouldTryMcp) {
      const result = await connectMcp(controller.signal);
      if (!result.connected) {
        console.warn(
          `[McpConnection] Chat fallback after ${result.state.error?.code ?? "connection failure"}`
        );
      }
    }
    // 最初の AI の応答を待つ間に、ログインを済ませておく（ログイン済みなら何もしない）。
    prewarmMoocsLogin();

    if (controller.signal.aborted) {
      throw new AppError("CHAT_CANCELLED", "リクエストがキャンセルされました");
    }

    const priorMaterials = store.selectRelevantMaterials(userText);
    const retrievedMaterials: MaterialContextInput[] = [];
    const response = await chatAgent.chat(
      userText,
      settings,
      controller.signal,
      [...store.getHistory(), userMessage],
      {
        priorMaterials,
        onMaterialsRetrieved: (materials) => {
          retrievedMaterials.push(...materials);
        },
      }
    );

    // A dependency may resolve after cancellation instead of rejecting. Never
    // repopulate history/material state after new-chat, clear, or cancel returned.
    if (controller.signal.aborted) {
      throw new AppError("CHAT_CANCELLED", "リクエストがキャンセルされました");
    }

    store.markMaterialsReferenced(priorMaterials.map((material) => material.id));
    store.addMaterials(retrievedMaterials);

    const assistantMessage = toAssistantTurn(
      response,
      `msg_${Date.now()}_ai`,
      new Date().toISOString()
    );
    // 未確定ターンを先に履歴へ入れない。失敗時のrollbackで上限履歴を失わないため、
    // user/assistant は回答確定後にまとめてcommitする。
    store.addMessage(userMessage);
    store.addMessage(assistantMessage);
    return response;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError("CHAT_CANCELLED", "リクエストがキャンセルされました");
    }
    const serialized = toSerializableError(error);
    throw new AppError(serialized.code, serialized.message);
  }
}

async function cancelActiveChat(): Promise<void> {
  const controller = activeController;
  const completion = activeChatCompletion;
  controller?.abort();
  if (completion) await waitAtMost(completion, 5_000);
}

async function connectMcp(
  signal?: AbortSignal,
  credentials?: McpCredentials
): Promise<McpConnectionResult> {
  if (shuttingDown) {
    const state: McpConnectionState = {
      status: "disconnected",
      lastConnectedAt: mcpConnectionState.lastConnectedAt,
    };
    return { connected: false, state };
  }
  if (signal?.aborted) throw chatCancelledError();
  if (activeConnection) {
    // 進行中の接続は別の認証情報かもしれない。共有すると、その成功を指定の値の成功と誤認する。
    if (credentials) {
      return {
        connected: false,
        error: "別の接続処理が進行中です。少し待ってからお試しください",
        state: mcpConnectionState,
      };
    }
    return waitForConnection(activeConnection.promise, signal);
  }

  const controller = new AbortController();
  const promise = ensureMcpConnected(
    mcpClient,
    broadcastMcpState,
    credentials ?? settingsStore.getRawSettings(),
    { signal: controller.signal }
  ).finally(() => {
    if (activeConnection?.controller === controller) activeConnection = null;
  });
  activeConnection = { controller, promise };
  return waitForConnection(promise, signal);
}

async function stopMcpConnection(): Promise<void> {
  resetAutomaticReconnectState();
  const previousConnection = activeConnection;
  previousConnection?.controller.abort();
  await disconnectMcp(mcpClient, broadcastMcpState);
  if (activeConnection === previousConnection) activeConnection = null;
}

async function reconnectMcp(): Promise<McpConnectionResult> {
  await stopMcpConnection();
  return connectMcp();
}

async function runMcpCredentialTest(input: McpCredentialTestInput): Promise<ConnectionTestResult> {
  if (shuttingDown) return { success: false, error: "アプリの終了処理中です" };
  if (activeController) {
    return { success: false, error: "回答の生成中は接続テストできません" };
  }
  if (credentialTestInFlight) return { success: false, error: "接続テストを実行中です" };

  credentialTestInFlight = true;
  try {
    return await testMcpCredentials(input, {
      getStoredCredentials: () => settingsStore.getRawSettings(),
      disconnect: stopMcpConnection,
      connect: (credentials) => connectMcp(undefined, credentials),
      verifyLogin: () => mcpClient.verifyMoocsLogin(),
      save: (validated) => settingsStore.updateSettings(validated),
      restoreStoredConnection: () => {
        void restoreStoredMcpConnection();
      },
    });
  } finally {
    credentialTestInFlight = false;
  }
}

async function restoreStoredMcpConnection(): Promise<void> {
  if (shuttingDown) return;
  if (settingsStore.hasMoocsCredentials()) {
    // 接続テストに失敗したあとの復元では、裏のログインはしない。保存されたパスワードが
    // 古い可能性が高く、質問もされていないのに SSO へ間違ったパスワードを送ることになる。
    await reconnectAfterCredentialChange({ prewarm: false });
    return;
  }
  await stopMcpConnection().catch(() => undefined);
}

function waitForConnection(
  promise: Promise<McpConnectionResult>,
  signal?: AbortSignal
): Promise<McpConnectionResult> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(chatCancelledError());

  return new Promise<McpConnectionResult>((resolve, reject) => {
    const onAbort = () => reject(chatCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function chatCancelledError(): AppError {
  return new AppError("CHAT_CANCELLED", "リクエストがキャンセルされました");
}

async function reconnectAfterCredentialChange(
  options: { prewarm: boolean } = { prewarm: true }
): Promise<void> {
  if (shuttingDown) return;
  const result = await reconnectMcp();
  if (result.connected) {
    if (options.prewarm) prewarmMoocsLogin("credential update");
  } else {
    console.warn(
      `[McpConnection] Credential update reconnect failed: ${connectionFailureLabel(result)}`
    );
  }
}

/**
 * 接続できたら、質問を待たずに裏で MOOCs へログインしておく。ログイン済みなら何もしない。
 * 失敗しても接続の状態は変わらない（McpClient.prewarmMoocsLogin）。本当の失敗は、
 * AI が moocs_login を呼んだときに画面へ届く。
 */
function prewarmMoocsLogin(logLabel?: string): void {
  if (shuttingDown || mcpClient.getStatus() !== "connected") return;
  const startedAt = Date.now();
  void mcpClient.prewarmMoocsLogin().then((loggedIn) => {
    if (!logLabel) return;
    const elapsed = Date.now() - startedAt;
    if (loggedIn) console.log(`[McpConnection] MOOCs login ready (${logLabel}, ${elapsed} ms)`);
    else console.warn(`[McpConnection] Background MOOCs login skipped or failed (${logLabel})`);
  });
}

/** 接続できなかった理由をログ用に短く表す。手動の切断で止まった場合はエラーが空になる。 */
function connectionFailureLabel(result: McpConnectionResult): string {
  if (result.state.error?.code) return result.state.error.code;
  return result.state.status === "disconnected" ? "cancelled" : "unknown";
}

function handleMcpConnectionIssue(error: McpClientError): void {
  if (shuttingDown) return;
  if (!error.retryable) {
    resetAutomaticReconnectState();
  }

  let reconnectDecision: AutomaticReconnectDecision | null | undefined;
  if (error.retryable && !automaticReconnectTimer) {
    reconnectDecision = automaticReconnectPolicy.recordIssue();
  }
  const reconnectLimitReached = reconnectDecision === null;
  broadcastMcpState({
    status: "error",
    lastConnectedAt: mcpConnectionState.lastConnectedAt,
    error: {
      code: error.code,
      message: error.message,
      guidance: reconnectLimitReached
        ? `${error.guidance} 短時間に切断が繰り返されたため、自動再接続を停止しました。画面の「再接続」を押してください。`
        : error.guidance,
      retryable: error.retryable,
    },
  });

  if (reconnectDecision) scheduleAutomaticReconnect(reconnectDecision);
}

function scheduleAutomaticReconnect(decision: AutomaticReconnectDecision): void {
  automaticReconnectTimer = setTimeout(() => {
    automaticReconnectTimer = null;
    if (shuttingDown || mcpClient.getStatus() === "connected") return;
    void connectMcp().catch(() => undefined);
  }, decision.delayMs);
}

function resetAutomaticReconnectState(): void {
  if (automaticReconnectTimer) clearTimeout(automaticReconnectTimer);
  automaticReconnectTimer = null;
  automaticReconnectPolicy.reset();
}

async function tryAutoConnectMcp(): Promise<void> {
  if (!settingsStore.hasMoocsCredentials()) return;
  const result = await connectMcp();
  if (result.connected) {
    console.log("[McpConnection] Startup connection established");
    prewarmMoocsLogin("startup");
  } else {
    console.warn(`[McpConnection] Startup connection failed: ${connectionFailureLabel(result)}`);
  }
}

function toConnectionTestResult(result: McpConnectionResult): ConnectionTestResult {
  return result.connected
    ? { success: true }
    : {
        success: false,
        error: result.state.error?.message ?? result.error ?? "MCP接続に失敗しました",
        guidance: result.state.error?.guidance,
      };
}

export function shutdownIpcServices(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  removeConnectionIssueListener?.();
  removeConnectionIssueListener = null;
  resetAutomaticReconnectState();

  shutdownPromise = (async () => {
    activeConnection?.controller.abort();
    await cancelActiveChat();
    if (activeConnection) await waitAtMost(activeConnection.promise, 5_000);
    await waitAtMost(disconnectMcp(mcpClient, broadcastMcpState), 5_000);
  })();
  return shutdownPromise;
}

async function waitAtMost(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

export const testExports = {
  services,
  store,
  mcpClient,
  chatAgent,
};
