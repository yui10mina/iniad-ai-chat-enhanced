/**
 * エージェントの実行記録（trace）のテスト。
 * イベントの順序、どの終わり方でも run_end が出ること、本文や検索語が記録に入らないこと、
 * 記録を足しても回答と API に送る body が変わらないことを確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRunner } from "../../src/main/chat-runner";
import {
  consoleTraceSink,
  createTraceEmitter,
  traceToolArgs,
  type AgentTraceEvent,
  type AgentTraceSink,
} from "../../src/main/services/agent-trace";
import { ChatAgent, type ChatAgentContext } from "../../src/main/services/chat-agent";
import { InMemoryStore } from "../../src/main/services/in-memory-store";
import type { McpClient } from "../../src/main/services/mcp-client";
import type { IWebSearchProvider } from "../../src/main/services/web-search-types";
import type { AppSettings } from "../../src/shared/types/settings";
import { installFakeLlm, navigateCall, type FakeReply } from "../helpers/fake-llm";

const settings: AppSettings = {
  apiKey: "test-key-SECRET",
  baseURL: "https://api.openai.iniad.org/api/v1",
  model: "gpt-test",
  moocsUsername: "",
  moocsPassword: "",
};

const SECRET = "SECRET";

function connectedMcp(overrides: Partial<McpClient> = {}): McpClient {
  return {
    getStatus: vi.fn().mockReturnValue("connected"),
    ping: vi.fn().mockResolvedValue(true),
    navigateTo: vi.fn().mockResolvedValue(undefined),
    getPageSnapshot: vi.fn().mockResolvedValue(""),
    ...overrides,
  } as unknown as McpClient;
}

const webClient: IWebSearchProvider = {
  search: vi.fn().mockResolvedValue({
    success: true,
    results: [
      {
        title: `Web ${SECRET}`,
        url: "https://example.com/page",
        snippet: `snippet ${SECRET}`,
        source: "web",
      },
    ],
  }),
};

function collector(): { events: AgentTraceEvent[]; sink: AgentTraceSink } {
  const events: AgentTraceEvent[] = [];
  return { events, sink: (event) => events.push(event) };
}

function types(events: AgentTraceEvent[]): string[] {
  return events.map((event) => event.type);
}

function only<T extends AgentTraceEvent["type"]>(
  events: AgentTraceEvent[],
  type: T
): Extract<AgentTraceEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<AgentTraceEvent, { type: T }> => event.type === type
  );
}

function runEnd(events: AgentTraceEvent[]) {
  const ends = only(events, "run_end");
  expect(ends).toHaveLength(1);
  expect(events[events.length - 1].type).toBe("run_end");
  return ends[0];
}

/** 1 回ツールを呼んでから回答する台本。 */
function oneToolThenAnswer(index: number): FakeReply {
  return index === 0 ? { toolCalls: [navigateCall("call_0", 1)] } : { content: "回答です。" };
}

async function run(
  reply: (index: number) => FakeReply,
  context: ChatAgentContext,
  mcp: McpClient = connectedMcp(),
  signal?: AbortSignal
) {
  const llm = installFakeLlm(reply);
  const agent = new ChatAgent(mcp, webClient);
  const result = await agent
    .chat("質問", settings, signal, undefined, context)
    .catch((e: unknown) => e);
  return { llm, result };
}

describe("agent trace", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("event order", () => {
    it("emits start and end events in the order things happen", async () => {
      const { events, sink } = collector();

      await run(oneToolThenAnswer, { traceSinks: [sink] });

      expect(types(events)).toEqual([
        "run_start",
        "llm_start",
        "llm_end",
        "tool_start",
        "tool_end",
        "llm_start",
        "llm_end",
        "run_end",
      ]);
      expect(only(events, "llm_start").map((event) => event.iteration)).toEqual([1, 2]);
      expect(only(events, "tool_start")[0]).toMatchObject({ iteration: 1, sequence: 1 });
      expect(only(events, "tool_end")[0]).toMatchObject({ iteration: 1, sequence: 1 });
    });

    // 進捗表示に使うので、待ち始める前に開始イベントが出ていなければならない。
    it("emits llm_start before the request and tool_start before the tool runs", async () => {
      const { events, sink } = collector();
      const seenAtRequest: string[] = [];
      const seenAtTool: string[] = [];
      const mcp = connectedMcp({
        navigateTo: vi.fn(async () => {
          seenAtTool.push(events[events.length - 1].type);
        }),
      });

      await run(
        (index) => {
          seenAtRequest.push(events[events.length - 1].type);
          return oneToolThenAnswer(index);
        },
        { traceSinks: [sink] },
        mcp
      );

      expect(seenAtRequest).toEqual(["llm_start", "llm_start"]);
      expect(seenAtTool).toEqual(["tool_start"]);
    });

    it("describes each request without its content", async () => {
      const { events, sink } = collector();

      const { llm } = await run(oneToolThenAnswer, { traceSinks: [sink] });

      expect(only(events, "llm_start")[0]).toMatchObject({
        iteration: 1,
        maxIterations: 10,
        messageCount: llm.requests[0].messages.length,
        toolsOffered: true,
        webSearchOffered: true,
        forcedFinal: false,
      });
      // moocs_ のツールを使ったあとは web_search を渡さない。
      expect(only(events, "llm_start")[1]).toMatchObject({ webSearchOffered: false });
      expect(only(events, "llm_end").map((event) => [event.toolCalls, event.contentChars])).toEqual(
        [
          [1, 0],
          [0, "回答です。".length],
        ]
      );
    });
  });

  describe("run_end on every way a run can finish", () => {
    it("reports a complete answer", async () => {
      const { events, sink } = collector();

      await run(oneToolThenAnswer, { traceSinks: [sink] });

      expect(runEnd(events)).toMatchObject({
        reason: "answered",
        iterations: 2,
        toolCalls: 1,
        answerChars: "回答です。".length,
        citations: 0,
      });
      expect(runEnd(events)).not.toHaveProperty("errorKind");
    });

    it("reports an answer cut off by the output limit", async () => {
      const { events, sink } = collector();

      await run(() => ({ content: "途中", finishReason: "length" }), { traceSinks: [sink] });

      expect(runEnd(events)).toMatchObject({ reason: "answer_incomplete", answerChars: 2 });
      expect(only(events, "llm_end")[0].finishReason).toBe("length");
    });

    it("reports the iteration limit", async () => {
      const { events, sink } = collector();

      const { result } = await run(
        (index) => ({ toolCalls: [navigateCall(`call_${index}`, index)] }),
        { traceSinks: [sink] }
      );

      expect(result).toBeInstanceOf(Error);
      expect(runEnd(events)).toMatchObject({
        reason: "iteration_limit",
        iterations: 10,
        toolCalls: 8,
        answerChars: 0,
      });
      // 9・10 回目は最終回答を求める段階なので、返ってきたツール呼び出しは実行しない。
      expect(only(events, "llm_end").map((event) => event.toolCallsDiscarded)).toEqual([
        ...Array<boolean>(8).fill(false),
        true,
        true,
      ]);
      expect(only(events, "llm_start").map((event) => event.forcedFinal)).toEqual([
        ...Array<boolean>(8).fill(false),
        true,
        true,
      ]);
    });

    it("reports an API failure with its kind and status but not its text", async () => {
      const { events, sink } = collector();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status: 500,
          headers: new Headers(),
          body: null,
          text: async () => `server said ${SECRET}`,
        }))
      );
      const agent = new ChatAgent(connectedMcp(), webClient);

      const error = await agent
        .chat("質問", settings, undefined, undefined, { traceSinks: [sink] })
        .catch((e: unknown) => e);

      expect((error as Error).message).toContain(SECRET);
      expect(types(events)).toEqual(["run_start", "llm_start", "run_end"]);
      expect(runEnd(events)).toMatchObject({ reason: "error", errorKind: "http", httpStatus: 500 });
      expect(JSON.stringify(events)).not.toContain(SECRET);
    });

    it("reports a cancel during a tool call", async () => {
      const { events, sink } = collector();
      const controller = new AbortController();
      const mcp = connectedMcp({
        navigateTo: vi.fn(async () => {
          controller.abort();
        }),
      });

      const { result } = await run(
        oneToolThenAnswer,
        { traceSinks: [sink] },
        mcp,
        controller.signal
      );

      expect(result).toBeInstanceOf(Error);
      expect(types(events)).toEqual(["run_start", "llm_start", "llm_end", "tool_start", "run_end"]);
      expect(runEnd(events)).toMatchObject({ reason: "cancelled", iterations: 1, toolCalls: 1 });
      expect(runEnd(events)).not.toHaveProperty("errorKind");
    });

    it("reports an empty answer", async () => {
      const { events, sink } = collector();

      await run(() => ({ content: "  " }), { traceSinks: [sink] });

      expect(runEnd(events)).toMatchObject({ reason: "error", errorKind: "empty-answer" });
    });

    it("reports a run that cannot start because the API key is missing", async () => {
      const { events, sink } = collector();
      const agent = new ChatAgent(connectedMcp(), webClient);

      await agent
        .chat("質問", { ...settings, apiKey: "" }, undefined, undefined, { traceSinks: [sink] })
        .catch(() => undefined);

      expect(types(events)).toEqual(["run_start", "run_end"]);
      expect(runEnd(events)).toMatchObject({ reason: "error", errorKind: "other", iterations: 0 });
    });
  });

  describe("what a tool call records", () => {
    it("keeps only the path of a MOOCs URL", async () => {
      const { events, sink } = collector();

      await run(
        (index) =>
          index === 0
            ? {
                toolCalls: [
                  {
                    id: "call_0",
                    name: "moocs_navigate",
                    arguments: JSON.stringify({
                      url: `https://moocs.iniad.org/courses/2026/TEST/1?token=${SECRET}#${SECRET}`,
                    }),
                  },
                ],
              }
            : { content: "回答です。" },
        { traceSinks: [sink] }
      );

      const start = only(events, "tool_start")[0];
      expect(start.tool).toBe("moocs_navigate");
      expect(start.args).toEqual({
        argsChars: expect.any(Number) as number,
        urlPath: "/courses/2026/TEST/1",
      });
      expect(only(events, "tool_end")[0]).toMatchObject({
        tool: "moocs_navigate",
        outcome: { ok: true, code: "ok" },
        resultChars: expect.any(Number) as number,
        materials: 0,
      });
    });

    it("records the length of a search query, not the query", async () => {
      const { events, sink } = collector();
      const query = `TCP ${SECRET}`;

      await run(
        (index) =>
          index === 0
            ? {
                toolCalls: [
                  { id: "call_0", name: "web_search", arguments: JSON.stringify({ query }) },
                ],
              }
            : { content: "回答です。" },
        { traceSinks: [sink] }
      );

      expect(only(events, "tool_start")[0].args).toEqual({
        argsChars: JSON.stringify({ query }).length,
        queryChars: query.length,
      });
      expect(JSON.stringify(events)).not.toContain(SECRET);
    });

    it("does not record a URL outside MOOCs or a tool name it does not know", async () => {
      const { events, sink } = collector();

      await run(
        (index) =>
          index === 0
            ? {
                toolCalls: [
                  {
                    id: "call_0",
                    name: "moocs_navigate",
                    arguments: JSON.stringify({ url: `https://evil.example/${SECRET}` }),
                  },
                  { id: "call_1", name: `tool_${SECRET}`, arguments: `{"note":"${SECRET}"}` },
                ],
              }
            : { content: "回答です。" },
        { traceSinks: [sink] }
      );

      const [navigate, unknown] = only(events, "tool_start");
      expect(navigate.args).toEqual({ argsChars: expect.any(Number) as number, urlRejected: true });
      expect(unknown.tool).toBe("unknown");
      expect(only(events, "tool_end").map((event) => event.outcome.code)).toEqual([
        "invalid_arguments",
        "unknown_tool",
      ]);
      expect(JSON.stringify(events)).not.toContain(SECRET);
    });

    it("records how a refused tool call ended", async () => {
      const { events, sink } = collector();
      const calls = Array.from({ length: 13 }, (_, i) => navigateCall(`call_${i}`, i));

      await run(
        (index) =>
          index === 0
            ? { toolCalls: calls }
            : index === 1
              ? { content: "回答です。" }
              : { content: "" },
        { traceSinks: [sink] }
      );

      const ends = only(events, "tool_end");
      expect(ends).toHaveLength(13);
      expect(ends[11].outcome).toEqual({ ok: true, code: "ok" });
      expect(ends[12].outcome).toEqual({ ok: false, code: "tool_limit_reached" });
      expect(runEnd(events)).toMatchObject({ toolCalls: 12 });
    });

    it("records a web_search refused after MOOCs browsing", async () => {
      const { events, sink } = collector();

      await run(
        (index) =>
          index === 0
            ? {
                toolCalls: [
                  navigateCall("call_0", 1),
                  { id: "call_1", name: "web_search", arguments: '{"query":"TCP"}' },
                ],
              }
            : { content: "回答です。" },
        { traceSinks: [sink] }
      );

      expect(only(events, "tool_end")[1]).toMatchObject({
        tool: "web_search",
        outcome: { ok: false, code: "web_search_blocked" },
      });
      expect(runEnd(events)).toMatchObject({ toolCalls: 1 });
    });
  });

  describe("no text from the run reaches the trace", () => {
    it("leaves out the question, answer, page text, error text and API key", async () => {
      const { events, sink } = collector();
      const mcp = connectedMcp({
        navigateTo: vi.fn().mockRejectedValue(new Error(`navigation failed ${SECRET}`)),
        getPageSnapshot: vi
          .fn()
          .mockResolvedValue(
            `- Page URL: https://moocs.iniad.org/courses/2026/TEST/1\n- Page Title: ${SECRET}\n本文 ${SECRET}`
          ),
      });
      const llm = installFakeLlm((index) =>
        index === 0
          ? {
              content: `考え中 ${SECRET}`,
              toolCalls: [
                navigateCall("call_0", 1),
                { id: "call_1", name: "moocs_page_content", arguments: "{}" },
              ],
            }
          : { content: `回答 ${SECRET}` }
      );
      const agent = new ChatAgent(mcp, webClient);

      const result = await agent.chat(
        `質問 ${SECRET}`,
        settings,
        undefined,
        [
          {
            id: "1",
            role: "user",
            content: `前の質問 ${SECRET}`,
            timestamp: "2026-11-14T00:00:00.000Z",
          },
        ],
        {
          traceSinks: [sink],
          priorMaterials: [
            {
              id: "material_1",
              title: `資料 ${SECRET}`,
              url: "https://moocs.iniad.org/courses/2026/TEST/9",
              content: `資料本文 ${SECRET}`,
              firstReferencedAt: "2026-11-14T00:00:00.000Z",
              lastReferencedAt: "2026-11-14T00:00:00.000Z",
              relevanceScore: 1,
            },
          ],
        }
      );

      // 台本どおり本文や秘密の文字列が実際に流れたことを確かめてから、記録を調べる。
      expect(result.content).toContain(SECRET);
      expect(JSON.stringify(llm.requests)).toContain(SECRET);
      expect(only(events, "tool_end").map((event) => event.outcome.code)).toEqual([
        "exception",
        "ok",
      ]);
      expect(only(events, "tool_end")[1]).toMatchObject({ materials: 1, citations: 1 });
      expect(only(events, "run_start")[0]).toMatchObject({ historyTurns: 1, priorMaterials: 1 });
      expect(JSON.stringify(events)).not.toContain(SECRET);
      expect(JSON.stringify(events)).not.toContain("質問");
      expect(JSON.stringify(events)).not.toContain("本文");
    });

    it("keeps only numbers from usage and null when the API sends none", async () => {
      const { events, sink } = collector();

      await run(
        (index) =>
          index === 0
            ? {
                toolCalls: [navigateCall("call_0", 1)],
                usage: {
                  prompt_tokens: 120,
                  completion_tokens: 8,
                  total_tokens: 128,
                  note: SECRET,
                },
              }
            : index === 1
              ? { content: "回答です。" }
              : { content: "" },
        { traceSinks: [sink] }
      );

      const [first, second] = only(events, "llm_end");
      expect(first.usage).toEqual({ promptTokens: 120, completionTokens: 8, totalTokens: 128 });
      expect(second.usage).toBeNull();
      expect(JSON.stringify(events)).not.toContain(SECRET);
    });

    it("turns an unexpected finish_reason into other and a missing one into null", async () => {
      const { events, sink } = collector();

      await run(
        (index) =>
          index === 0
            ? { toolCalls: [navigateCall("call_0", 1)], finishReason: `weird ${SECRET}` }
            : { content: "回答です。", finishReason: null },
        { traceSinks: [sink] }
      );

      expect(only(events, "llm_end").map((event) => event.finishReason)).toEqual(["other", null]);
    });
  });

  describe("sinks", () => {
    it("gives every sink every event, even when one of them throws", async () => {
      const first = collector();
      const last = collector();
      const failing: AgentTraceSink = () => {
        throw new Error("sink failed");
      };

      const { result } = await run(oneToolThenAnswer, {
        traceSinks: [first.sink, failing, last.sink],
      });

      expect(result).toMatchObject({ content: "回答です。" });
      expect(types(first.events)).toHaveLength(8);
      expect(last.events).toEqual(first.events);
    });

    it("does not change the answer or the requests sent to the API", async () => {
      const plain = await run(oneToolThenAnswer, {});
      vi.unstubAllGlobals();
      const traced = await run(oneToolThenAnswer, { traceSinks: [collector().sink] });

      expect(traced.llm.requests).toEqual(plain.llm.requests);
      expect({ ...(traced.result as object), latencyMs: 0 }).toEqual({
        ...(plain.result as object),
        latencyMs: 0,
      });
    });

    it("stamps each event with the time it was emitted", () => {
      const { events, sink } = collector();
      let now = 1_000;
      const emit = createTraceEmitter([sink], () => now);

      emit({ type: "run_start", historyTurns: 0, priorMaterials: 0, hasSyllabusHint: false });
      now = 1_250;
      emit({
        type: "run_end",
        durationMs: 250,
        reason: "answered",
        iterations: 1,
        toolCalls: 0,
        answerChars: 3,
        citations: 0,
      });

      expect(events.map((event) => event.at)).toEqual([1_000, 1_250]);
    });

    it("prints the same console lines as before through the console sink", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const { llm } = await run(oneToolThenAnswer, { traceSinks: [consoleTraceSink] });

      const lines = log.mock.calls.map((call) => String(call[0]));
      const payloadChars = JSON.stringify(llm.requests[0].messages).length;
      expect(lines[0]).toBe(
        `[Agent] iteration 1/10, messages=2, payload~${payloadChars} chars, forceFinal=false`
      );
      expect(lines[1]).toBe("[Agent] tool: moocs_navigate");
      expect(lines[lines.length - 1]).toMatch(
        /^\[Agent\] run end: answered, \d+ ms, iterations=2, tools=1$/
      );
    });

    it("passes the runner's sinks to the agent", async () => {
      const { sink } = collector();
      const chat = vi.fn().mockResolvedValue({ content: "回答です。", citations: [] });
      const runner = new ChatRunner({
        store: new InMemoryStore(),
        chatAgent: { chat },
        getSettings: () => settings,
        prepareMcp: () => undefined,
        traceSinks: [sink],
      });

      await runner.send("質問");

      expect((chat.mock.calls[0] as unknown[])[4]).toMatchObject({ traceSinks: [sink] });
    });
  });

  describe("traceToolArgs", () => {
    it.each<{ name: string; argsJson: string; expected: object }>([
      { name: "arguments that are not JSON", argsJson: '{"url":', expected: { argsChars: 7 } },
      { name: "an array", argsJson: "[1]", expected: { argsChars: 3 } },
      { name: "an empty string", argsJson: "", expected: { argsChars: 0 } },
      {
        name: "a URL that is not a string",
        argsJson: '{"url":5}',
        expected: { argsChars: 9, urlRejected: true },
      },
      {
        name: "an http MOOCs URL",
        argsJson: '{"url":"http://moocs.iniad.org/a"}',
        expected: { argsChars: 34, urlRejected: true },
      },
      {
        name: "a look-alike host",
        argsJson: '{"url":"https://moocs.iniad.org.evil.example/a"}',
        expected: { argsChars: 48, urlRejected: true },
      },
    ])("keeps nothing unsafe from $name", ({ argsJson, expected }) => {
      expect(traceToolArgs(argsJson)).toEqual(expected);
    });

    it("cuts a very long path", () => {
      const url = `https://moocs.iniad.org/${"a".repeat(500)}`;

      expect(traceToolArgs(JSON.stringify({ url })).urlPath).toHaveLength(200);
    });
  });
});
