/**
 * IPC ハンドラーの「今の動き」を固定するテスト。本番コードは変えない。
 * 信頼境界（誰の呼び出しを受けるか）と、chat:send が履歴と資料をいつ保存するかを見る。
 * 途中で失敗しても取得済みの資料は残す（PR11 で反転した）。キャンセルしたときは残さない。
 *
 * ipc-handlers は import した時点でサービスを作るので、electron、app-services、
 * settings-store、mcp-credential-test を差し替え、テストごとにモジュールを読み直す。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAgentContext } from "../../src/main/services/chat-agent";
import type { InMemoryStore, MaterialContextInput } from "../../src/main/services/in-memory-store";
import type { ChatResponse, ChatTurn } from "../../src/shared/types/chat";
import type { AppSettings, ConnectionTestResult } from "../../src/shared/types/settings";

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
type ChatFn = (
  userText: string,
  settings: AppSettings,
  signal: AbortSignal,
  history: ChatTurn[],
  context: ChatAgentContext
) => Promise<ChatResponse>;

const fakes = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  chat: vi.fn(),
  disconnect: vi.fn(),
  onConnectionIssue: vi.fn(),
  testMcpCredentials: vi.fn(),
  store: undefined as unknown,
  windows: [] as unknown[],
  registeredSink: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      fakes.handlers.set(channel, handler);
    },
  },
  BrowserWindow: { getAllWindows: () => fakes.windows },
  shell: { openExternal: vi.fn() },
}));

vi.mock("../../src/main/services/app-services", async () => {
  const { InMemoryStore: Store } = await import("../../src/main/services/in-memory-store");
  return {
    createAppServices: () => {
      const store = new Store();
      fakes.store = store;
      return {
        store,
        mcpClient: {
          getStatus: () => "disconnected",
          onConnectionIssue: fakes.onConnectionIssue,
          disconnect: fakes.disconnect,
        },
        chatAgent: { chat: fakes.chat },
      };
    },
  };
});

vi.mock("../../src/main/services/settings-store", () => ({
  settingsStore: {
    getRawSettings: () => SETTINGS,
    getSettings: () => ({ model: SETTINGS.model }),
    hasApiKey: () => true,
    // 資格情報なしにして、起動時と質問時の MCP 接続を始めさせない。
    hasMoocsCredentials: () => false,
    updateSettings: vi.fn(),
  },
}));

vi.mock("../../src/main/services/mcp-credential-test", () => ({
  testMcpCredentials: fakes.testMcpCredentials,
}));

const SETTINGS: AppSettings = {
  apiKey: "test-key",
  baseURL: "https://api.openai.iniad.org/api/v1",
  model: "gpt-6-luna",
  moocsUsername: "",
  moocsPassword: "",
};

const TRUSTED_ID = 1;
const ANSWER: ChatResponse = { content: "回答です。", citations: [], latencyMs: 5 };
const MATERIAL: MaterialContextInput = {
  title: "第1回 スライド",
  url: "https://moocs.iniad.org/courses/2026/TEST/1/1",
  content: "TCP は接続を確立してからデータを送る。",
  sourceType: "moocs",
};

const NO_ARG_CHANNELS = [
  "chat:cancel",
  "chat:list",
  "chat:new",
  "chat:clear",
  "context:list",
  "context:clear",
  "app:status",
  "settings:get",
  "mcp:reconnect",
];
const ALL_CHANNELS = [
  ...NO_ARG_CHANNELS,
  "chat:send",
  "settings:set",
  "settings:test-mcp",
  "external:open",
];

interface FakeEventOptions {
  id?: number;
  subframe?: boolean;
  destroyed?: boolean;
}

function fakeEvent(options: FakeEventOptions = {}): unknown {
  const mainFrame = { name: "main" };
  return {
    sender: {
      id: options.id ?? TRUSTED_ID,
      mainFrame,
      isDestroyed: () => options.destroyed === true,
    },
    senderFrame: options.subframe ? { name: "child" } : mainFrame,
  };
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return invokeAs(fakeEvent(), channel, ...args);
}

function invokeAs(event: unknown, channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = fakes.handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return handler(event, ...args);
}

function store(): InMemoryStore {
  return fakes.store as InMemoryStore;
}

/** n 回目の chat 呼び出しに渡されたキャンセル用シグナル */
function signalOfCall(index: number): AbortSignal {
  return (fakes.chat.mock.calls[index] as Parameters<ChatFn>)[2];
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** キャンセルされるまで終わらない回答。キャンセルされたら例外で終わる。 */
function chatUntilAborted(): ChatFn {
  return (_text, _settings, signal) =>
    new Promise<ChatResponse>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
}

/** 資料を 1 件取得したあとで失敗する回答。 */
function failAfterRetrieving(material: MaterialContextInput): ChatFn {
  return async (...args) => {
    args[4].onMaterialsRetrieved?.([material]);
    throw new Error("途中で失敗");
  };
}

let ipc: typeof import("../../src/main/ipc-handlers");

beforeEach(async () => {
  vi.resetModules();
  fakes.handlers.clear();
  fakes.windows = [];
  fakes.chat.mockReset();
  fakes.disconnect.mockReset().mockResolvedValue(undefined);
  fakes.onConnectionIssue.mockReset().mockReturnValue(() => undefined);
  fakes.testMcpCredentials.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  ipc = await import("../../src/main/ipc-handlers");
  fakes.registeredSink.mockReset();
  ipc.registerIpcHandlers({
    isTrustedSender: (id) => id === TRUSTED_ID,
    traceSinks: [fakes.registeredSink],
  });
});

describe("IPC handlers (current behaviour)", () => {
  describe("registration", () => {
    it("registers exactly the expected channels", () => {
      expect([...fakes.handlers.keys()].sort()).toEqual([...ALL_CHANNELS].sort());
    });

    it("registers only once even when called again", () => {
      const registered = new Map(fakes.handlers);

      ipc.registerIpcHandlers({ isTrustedSender: () => true });

      expect(fakes.onConnectionIssue).toHaveBeenCalledTimes(1);
      for (const [channel, handler] of registered) {
        expect(fakes.handlers.get(channel)).toBe(handler);
      }
      // 2 回目の isTrustedSender（誰でも許可）は使われない。
      return expect(invokeAs(fakeEvent({ id: 99 }), "chat:list")).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    });
  });

  describe("trust boundary", () => {
    it("serves the trusted window's main frame", async () => {
      await expect(invoke("chat:list")).resolves.toEqual([]);
    });

    it.each<{ name: string; options: FakeEventOptions }>([
      { name: "a webContents that is not trusted", options: { id: 99 } },
      { name: "a subframe of the trusted window", options: { subframe: true } },
      { name: "a destroyed sender", options: { destroyed: true } },
    ])("rejects $name on every channel", async ({ options }) => {
      for (const channel of ALL_CHANNELS) {
        await expect(invokeAs(fakeEvent(options), channel)).rejects.toMatchObject({
          name: "AppError",
          code: "PERMISSION_DENIED",
        });
      }
    });

    it("does not start a chat for an untrusted sender", async () => {
      await expect(invokeAs(fakeEvent({ id: 99 }), "chat:send", "質問")).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });

      expect(fakes.chat).not.toHaveBeenCalled();
    });

    it.each(NO_ARG_CHANNELS)("rejects an argument on %s", async (channel) => {
      await expect(invoke(channel, { unexpected: true })).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: `IPC ${channel} does not accept arguments`,
      });
    });
  });

  describe("chat:send", () => {
    it("rejects input that is not a non-empty string without calling the agent", async () => {
      await expect(invoke("chat:send", { text: "質問" })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      await expect(invoke("chat:send", "   ")).rejects.toMatchObject({ code: "INVALID_INPUT" });

      expect(fakes.chat).not.toHaveBeenCalled();
    });

    it("returns the answer and stores the user and assistant turns together", async () => {
      fakes.chat.mockResolvedValue(ANSWER);

      await expect(invoke("chat:send", "  質問です  ")).resolves.toEqual(ANSWER);

      const history = store().getHistory();
      expect(history.map((turn) => [turn.role, turn.content])).toEqual([
        ["user", "質問です"],
        ["assistant", "回答です。"],
      ]);
      expect(Object.keys(history[1])).not.toContain("completion");
    });

    it("passes the trimmed text, the settings and a history ending with this question", async () => {
      fakes.chat.mockResolvedValue(ANSWER);
      await invoke("chat:send", "1問目");
      await invoke("chat:send", " 2問目 ");

      const [text, settings, signal, history] = fakes.chat.mock.calls[1] as Parameters<ChatFn>;
      expect(text).toBe("2問目");
      expect(settings).toEqual(SETTINGS);
      expect(signal.aborted).toBe(false);
      expect(history.map((turn) => [turn.role, turn.content])).toEqual([
        ["user", "1問目"],
        ["assistant", "回答です。"],
        ["user", "2問目"],
      ]);
    });

    it("keeps the cut-off mark on the stored assistant turn", async () => {
      fakes.chat.mockResolvedValue({ ...ANSWER, completion: "truncated" });

      await invoke("chat:send", "質問");

      expect(store().getHistory()[1].completion).toBe("truncated");
    });

    it("stores the material retrieved during a successful answer", async () => {
      fakes.chat.mockImplementation(async (...args: Parameters<ChatFn>) => {
        args[4].onMaterialsRetrieved?.([MATERIAL]);
        return ANSWER;
      });

      await invoke("chat:send", "質問");

      expect(store().getMaterialContextSummaries()).toMatchObject([{ url: MATERIAL.url }]);
    });

    it("hands the agent the stored material that matches the question", async () => {
      store().addMaterial(MATERIAL);
      fakes.chat.mockResolvedValue(ANSWER);

      await invoke("chat:send", "TCP について教えて");

      const context = (fakes.chat.mock.calls[0] as Parameters<ChatFn>)[4];
      expect(context.priorMaterials).toMatchObject([{ url: MATERIAL.url }]);
    });

    it("adds nothing to the history when the agent fails", async () => {
      fakes.chat.mockRejectedValue(new Error("API が空の回答を返しました"));

      await expect(invoke("chat:send", "質問")).rejects.toMatchObject({
        name: "AppError",
        code: "UNKNOWN",
        message: "API が空の回答を返しました",
      });

      expect(store().getHistory()).toEqual([]);
    });

    it("keeps material retrieved before a failure", async () => {
      fakes.chat.mockImplementation(failAfterRetrieving(MATERIAL));

      await expect(invoke("chat:send", "質問")).rejects.toMatchObject({
        name: "AppError",
        code: "UNKNOWN",
        message: "途中で失敗",
      });

      expect(store().getMaterialContextSummaries()).toMatchObject([{ url: MATERIAL.url }]);
    });

    it("adds nothing to the history when a failure leaves material behind", async () => {
      fakes.chat.mockImplementation(failAfterRetrieving(MATERIAL));

      await expect(invoke("chat:send", "質問")).rejects.toMatchObject({ message: "途中で失敗" });

      expect(store().getHistory()).toEqual([]);
    });

    it("offers the material kept from a failed question to the next question", async () => {
      fakes.chat
        .mockImplementationOnce(failAfterRetrieving(MATERIAL))
        .mockResolvedValueOnce(ANSWER);
      await expect(invoke("chat:send", "1問目")).rejects.toMatchObject({ message: "途中で失敗" });

      await invoke("chat:send", "TCP について教えて");

      const context = (fakes.chat.mock.calls[1] as Parameters<ChatFn>)[4];
      expect(context.priorMaterials).toMatchObject([{ url: MATERIAL.url }]);
    });

    it("does not move earlier material to the front when the question that used it fails", async () => {
      const other: MaterialContextInput = {
        ...MATERIAL,
        title: "第2回 スライド",
        url: "https://moocs.iniad.org/courses/2026/TEST/2/1",
        content: "UDP は接続を確立しない。",
      };
      store().addMaterial(MATERIAL);
      store().addMaterial(other);
      fakes.chat.mockRejectedValue(new Error("失敗"));

      await expect(invoke("chat:send", "TCP について教えて")).rejects.toMatchObject({
        message: "失敗",
      });

      // 回答が確定していないので、使われた資料の「最近参照した」順は変えない。
      expect(
        store()
          .getMaterialContextSummaries()
          .map((summary) => summary.url)
      ).toEqual([other.url, MATERIAL.url]);
    });

    it("accepts the next question after a failure", async () => {
      fakes.chat.mockRejectedValueOnce(new Error("失敗")).mockResolvedValueOnce(ANSWER);

      await expect(invoke("chat:send", "1問目")).rejects.toMatchObject({ message: "失敗" });
      await expect(invoke("chat:send", "2問目")).resolves.toEqual(ANSWER);

      expect(
        store()
          .getHistory()
          .map((turn) => turn.content)
      ).toEqual(["2問目", "回答です。"]);
    });

    it("rejects a second question while the first is still running", async () => {
      const first = deferred<ChatResponse>();
      fakes.chat.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ANSWER);
      const running = invoke("chat:send", "1問目");

      await expect(invoke("chat:send", "2問目")).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "別の回答を生成中です",
      });
      expect(fakes.chat).toHaveBeenCalledTimes(1);

      first.resolve(ANSWER);
      await running;
      await expect(invoke("chat:send", "3問目")).resolves.toEqual(ANSWER);
    });
  });

  describe("progress", () => {
    const LLM_START = {
      type: "llm_start",
      at: 1,
      iteration: 1,
      maxIterations: 10,
      messageCount: 2,
      payloadChars: 900,
      toolsOffered: true,
      webSearchOffered: true,
      forcedFinal: false,
    } as const;

    /** 進捗を受け取れる送信元。send の呼び出しを記録する。 */
    function senderEvent() {
      const mainFrame = { name: "main" };
      const sender = {
        id: TRUSTED_ID,
        mainFrame,
        isDestroyed: vi.fn().mockReturnValue(false),
        send: vi.fn(),
      };
      return { sender, event: { sender, senderFrame: mainFrame } };
    }

    function otherWindow() {
      const webContents = { isDestroyed: () => false, send: vi.fn() };
      fakes.windows = [{ isDestroyed: () => false, webContents }];
      return webContents;
    }

    it("sends progress only to the window that asked, not to every window", async () => {
      const other = otherWindow();
      const { sender, event } = senderEvent();
      fakes.chat.mockImplementation(async (...args: Parameters<ChatFn>) => {
        for (const sink of args[4].traceSinks ?? []) sink(LLM_START);
        return ANSWER;
      });

      await expect(invokeAs(event, "chat:send", "質問")).resolves.toEqual(ANSWER);

      expect(sender.send.mock.calls).toEqual([
        ["chat:progress", { kind: "thinking", iteration: 1, maxIterations: 10, final: false }],
      ]);
      expect(other.send).not.toHaveBeenCalled();
    });

    it("stops sending progress when the window is closed during the run", async () => {
      const { sender, event } = senderEvent();
      fakes.chat.mockImplementation(async (...args: Parameters<ChatFn>) => {
        const sinks = args[4].traceSinks ?? [];
        for (const sink of sinks) sink(LLM_START);
        sender.isDestroyed.mockReturnValue(true);
        for (const sink of sinks) sink({ ...LLM_START, iteration: 2 });
        return ANSWER;
      });

      await invokeAs(event, "chat:send", "質問");

      expect(sender.send).toHaveBeenCalledTimes(1);
    });

    it("also gives the events to the sinks passed at registration, and only those", async () => {
      const lateSink = vi.fn();
      ipc.registerIpcHandlers({ isTrustedSender: () => true, traceSinks: [lateSink] });
      const { event } = senderEvent();
      fakes.chat.mockImplementation(async (...args: Parameters<ChatFn>) => {
        for (const sink of args[4].traceSinks ?? []) sink(LLM_START);
        return ANSWER;
      });

      await invokeAs(event, "chat:send", "質問");

      expect(fakes.registeredSink.mock.calls).toEqual([[LLM_START]]);
      // 2 回目の登録は無視されるので、そのとき渡した送り先は使われない。
      expect(lateSink).not.toHaveBeenCalled();
    });

    it("does not carry one question's progress target over to the next question", async () => {
      const first = senderEvent();
      const second = senderEvent();
      fakes.chat.mockImplementation(async (...args: Parameters<ChatFn>) => {
        for (const sink of args[4].traceSinks ?? []) sink(LLM_START);
        return ANSWER;
      });

      await invokeAs(first.event, "chat:send", "1問目");
      await invokeAs(second.event, "chat:send", "2問目");

      expect(first.sender.send).toHaveBeenCalledTimes(1);
      expect(second.sender.send).toHaveBeenCalledTimes(1);
    });
  });

  describe("cancellation", () => {
    it("reports a cancelled chat as CHAT_CANCELLED and stores nothing", async () => {
      fakes.chat.mockImplementation(chatUntilAborted());
      const running = invoke("chat:send", "質問");
      const outcome = expect(running).rejects.toMatchObject({
        name: "AppError",
        code: "CHAT_CANCELLED",
      });

      await invoke("chat:cancel");
      // 中断されなければ outcome は終わらないので、先にシグナルを確かめる。
      expect(signalOfCall(0).aborted).toBe(true);
      await outcome;

      expect(store().getHistory()).toEqual([]);
    });

    it("discards material retrieved before a cancel", async () => {
      fakes.chat.mockImplementation((...args: Parameters<ChatFn>) => {
        args[4].onMaterialsRetrieved?.([MATERIAL]);
        return chatUntilAborted()(...args);
      });
      const running = invoke("chat:send", "質問");
      const outcome = expect(running).rejects.toMatchObject({ code: "CHAT_CANCELLED" });

      await invoke("chat:cancel");
      expect(signalOfCall(0).aborted).toBe(true);
      await outcome;

      expect(store().getMaterialContextSummaries()).toEqual([]);
    });

    it("stores nothing when the agent resolves after the cancel instead of rejecting", async () => {
      fakes.chat.mockImplementation(
        (...args: Parameters<ChatFn>) =>
          new Promise<ChatResponse>((resolve) => {
            args[2].addEventListener(
              "abort",
              () => {
                args[4].onMaterialsRetrieved?.([MATERIAL]);
                resolve(ANSWER);
              },
              { once: true }
            );
          })
      );
      const running = invoke("chat:send", "質問");
      const outcome = expect(running).rejects.toMatchObject({ code: "CHAT_CANCELLED" });

      await invoke("chat:cancel");
      expect(signalOfCall(0).aborted).toBe(true);
      await outcome;

      expect(store().getHistory()).toEqual([]);
      expect(store().getMaterialContextSummaries()).toEqual([]);
    });

    it.each(["chat:new", "chat:clear"])(
      "%s cancels the running chat and empties the history but keeps materials",
      async (channel) => {
        fakes.chat.mockResolvedValueOnce(ANSWER);
        await invoke("chat:send", "1問目");
        store().addMaterial(MATERIAL);
        fakes.chat.mockImplementation(chatUntilAborted());
        const running = invoke("chat:send", "2問目");
        const outcome = expect(running).rejects.toMatchObject({ code: "CHAT_CANCELLED" });

        await invoke(channel);
        expect(signalOfCall(1).aborted).toBe(true);
        await outcome;

        expect(store().getHistory()).toEqual([]);
        expect(store().getMaterialContextSummaries()).toHaveLength(1);
      }
    );

    it("context:clear cancels the running chat and removes materials but keeps the history", async () => {
      fakes.chat.mockResolvedValueOnce(ANSWER);
      await invoke("chat:send", "1問目");
      store().addMaterial(MATERIAL);
      fakes.chat.mockImplementation(chatUntilAborted());
      const running = invoke("chat:send", "2問目");
      const outcome = expect(running).rejects.toMatchObject({ code: "CHAT_CANCELLED" });

      await invoke("context:clear");
      expect(signalOfCall(1).aborted).toBe(true);
      await outcome;

      expect(store().getMaterialContextSummaries()).toEqual([]);
      expect(store().getHistory()).toHaveLength(2);
    });
  });

  describe("MOOCs credential test", () => {
    it("rejects a question while a credential test is running", async () => {
      const testing = deferred<ConnectionTestResult>();
      fakes.testMcpCredentials.mockReturnValue(testing.promise);
      const test = invoke("settings:test-mcp", {});

      await expect(invoke("chat:send", "質問")).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "MOOCs の接続テスト中です。終わってから送信してください",
      });
      expect(fakes.chat).not.toHaveBeenCalled();

      testing.resolve({ success: true });
      await expect(test).resolves.toEqual({ success: true });
      fakes.chat.mockResolvedValue(ANSWER);
      await expect(invoke("chat:send", "質問")).resolves.toEqual(ANSWER);
    });

    it("refuses a credential test while an answer is being generated", async () => {
      fakes.chat.mockImplementation(chatUntilAborted());
      const running = invoke("chat:send", "質問");
      const outcome = expect(running).rejects.toMatchObject({ code: "CHAT_CANCELLED" });

      await expect(invoke("settings:test-mcp", {})).resolves.toEqual({
        success: false,
        error: "回答の生成中は接続テストできません",
      });
      expect(fakes.testMcpCredentials).not.toHaveBeenCalled();

      await invoke("chat:cancel");
      expect(signalOfCall(0).aborted).toBe(true);
      await outcome;
    });
  });

  describe("shutdown", () => {
    it("returns the same promise and disconnects only once when called twice", async () => {
      const first = ipc.shutdownIpcServices();
      const second = ipc.shutdownIpcServices();

      expect(second).toBe(first);
      await first;

      expect(fakes.disconnect).toHaveBeenCalledTimes(1);
    });

    it("cancels the running chat during shutdown", async () => {
      fakes.chat.mockImplementation(chatUntilAborted());
      const running = invoke("chat:send", "質問");
      const outcome = expect(running).rejects.toMatchObject({ code: "CHAT_CANCELLED" });

      await ipc.shutdownIpcServices();
      expect(signalOfCall(0).aborted).toBe(true);
      await outcome;

      expect(store().getHistory()).toEqual([]);
    });
  });
});
