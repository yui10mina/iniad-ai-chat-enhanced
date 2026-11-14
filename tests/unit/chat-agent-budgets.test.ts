/**
 * 時間とトークンの予算を、エージェントのループを通して確かめる。
 * 予算を超えたら、調査を打ち切って回答させる。例外にも、キャンセルにもしない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTraceEvent } from "../../src/main/services/agent-trace";
import { ChatAgent } from "../../src/main/services/chat-agent";
import type { McpClient } from "../../src/main/services/mcp-client";
import type { AppSettings } from "../../src/shared/types/settings";
import { installFakeLlm, navigateCall, toolNames, type FakeReply } from "../helpers/fake-llm";

const settings: AppSettings = {
  apiKey: "test-key",
  baseURL: "https://api.openai.iniad.org/api/v1",
  model: "gpt-test",
  moocsUsername: "",
  moocsPassword: "",
};

const FINAL_ANSWER_HINT =
  "十分な情報が集まりました。ツールは使わず、これまでの調査結果だけを使って日本語で回答してください。";
const SLIDE_URL = "https://moocs.iniad.org/courses/2099/TEST101/01/01";
const SLIDE_TEXT =
  "合成スライド。これは架空の本文で、実在の教材ではない。架空の用語アルファを説明する。";

function slideMcp(onNavigate: () => void = () => undefined): McpClient {
  let currentUrl = "";
  return {
    getStatus: vi.fn().mockReturnValue("connected"),
    ping: vi.fn().mockResolvedValue(true),
    navigateTo: vi.fn(async (url: string) => {
      currentUrl = url;
      onNavigate();
    }),
    loginToGoogle: vi.fn().mockResolvedValue(undefined),
    expandSlideTab: vi.fn().mockResolvedValue(undefined),
    extractGoogleSlideText: vi.fn(async () => ({
      content: [{ type: "text", text: JSON.stringify({ moocsUrl: currentUrl, text: SLIDE_TEXT }) }],
    })),
  } as unknown as McpClient;
}

function usage(promptTokens: number) {
  return { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 };
}

async function run(reply: (index: number) => FakeReply, mcp: McpClient = slideMcp()) {
  const llm = installFakeLlm(reply);
  const events: AgentTraceEvent[] = [];
  const materials: string[] = [];
  const agent = new ChatAgent(mcp, { search: vi.fn() });
  const result = await agent
    .chat("質問", settings, undefined, undefined, {
      traceSinks: [(event) => events.push(event)],
      onMaterialsRetrieved: (retrieved) => materials.push(...retrieved.map((m) => m.url)),
    })
    .catch((error: unknown) => error as Error);
  const runEnd = events[events.length - 1];
  return { llm, result, events, materials, runEnd };
}

describe("ChatAgent time and token budgets", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("token budget", () => {
    it("stops offering tools and asks for an answer once the prompt tokens reach the budget", async () => {
      const { llm, result, runEnd, events } = await run((index) =>
        index < 2
          ? { toolCalls: [navigateCall(`call_${index}`, index)], usage: usage(30_000) }
          : { content: "回答です。", usage: usage(30_000) }
      );

      // 1 回目と 2 回目で合計 60,000。3 回目はツールなしで、回答を促す一文が付く。
      expect(llm.requests).toHaveLength(3);
      expect(toolNames(llm.requests[1])).not.toHaveLength(0);
      expect(llm.requests[2]).not.toHaveProperty("tools");
      expect(llm.requests[2].messages[llm.requests[2].messages.length - 1]).toEqual({
        role: "user",
        content: FINAL_ANSWER_HINT,
      });
      // 例外ではなく回答が返り、終わり方は「回答した」で、超えた予算が記録に残る。
      expect(result).toMatchObject({ content: "回答です。" });
      expect(runEnd).toMatchObject({
        type: "run_end",
        reason: "answered",
        exceededBudget: "tokens",
        iterations: 3,
        toolCalls: 2,
      });
      expect(
        events.flatMap((event) => (event.type === "llm_start" ? [event.forcedFinal] : []))
      ).toEqual([false, false, true]);
    });

    it("does not run tool calls the model still makes after the budget, and keeps asking for an answer", async () => {
      const mcp = slideMcp();
      const { llm, result, runEnd } = await run(
        (index) =>
          index < 3
            ? { toolCalls: [navigateCall(`call_${index}`, index)], usage: usage(60_000) }
            : { content: "回答です。", usage: usage(1_000) },
        mcp
      );

      expect(mcp.navigateTo).toHaveBeenCalledTimes(1);
      expect(llm.requests).toHaveLength(4);
      expect(llm.requests[2]).not.toHaveProperty("tools");
      expect(llm.requests[3]).not.toHaveProperty("tools");
      expect(result).toMatchObject({ content: "回答です。" });
      expect(runEnd).toMatchObject({ reason: "answered", exceededBudget: "tokens", toolCalls: 1 });
    });

    it("is not applied when the API sends no usage", async () => {
      const { llm, runEnd } = await run((index) =>
        index < 4
          ? { toolCalls: [navigateCall(`call_${index}`, index)] }
          : { content: "回答です。" }
      );

      expect(toolNames(llm.requests[4])).not.toHaveLength(0);
      expect(runEnd).not.toHaveProperty("exceededBudget");
    });

    it("is not applied once any response came without usage, however large the others are", async () => {
      const { llm, runEnd } = await run((index) =>
        index === 0
          ? { toolCalls: [navigateCall("call_0", 0)] }
          : index < 3
            ? { toolCalls: [navigateCall(`call_${index}`, index)], usage: usage(90_000) }
            : { content: "回答です。", usage: usage(90_000) }
      );

      expect(toolNames(llm.requests[3])).not.toHaveLength(0);
      expect(runEnd).not.toHaveProperty("exceededBudget");
    });

    it("leaves a run under the budget alone", async () => {
      const { llm, runEnd } = await run((index) =>
        index < 2
          ? { toolCalls: [navigateCall(`call_${index}`, index)], usage: usage(29_999) }
          : { content: "回答です。", usage: usage(1) }
      );

      expect(toolNames(llm.requests[2])).not.toHaveLength(0);
      expect(runEnd).toMatchObject({ reason: "answered" });
      expect(runEnd).not.toHaveProperty("exceededBudget");
    });
  });

  describe("time budget", () => {
    it("asks for an answer after the time budget, keeps what was read, and is not a cancel", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
      // スライドを開くのに 151 秒かかったことにする。
      const mcp = slideMcp(() => vi.setSystemTime(Date.now() + 151_000));

      const { llm, result, runEnd, materials } = await run(
        (index) =>
          index === 0
            ? {
                toolCalls: [
                  {
                    id: "call_0",
                    name: "moocs_read_slide",
                    arguments: JSON.stringify({ url: SLIDE_URL }),
                  },
                ],
              }
            : { content: "回答です。" },
        mcp
      );

      expect(llm.requests).toHaveLength(2);
      expect(llm.requests[1]).not.toHaveProperty("tools");
      expect(result).toMatchObject({
        content: "回答です。",
        citations: [expect.objectContaining({ url: SLIDE_URL })],
      });
      // 読み終えた資料は、打ち切ったあとも保存に回されている。
      expect(materials).toEqual([SLIDE_URL]);
      expect(runEnd).toMatchObject({ reason: "answered", exceededBudget: "time" });
      // 読んだ本文は、回答を求める問い合わせに含まれている。
      expect(JSON.stringify(llm.requests[1])).toContain("アルファ");
    });

    it("does not interrupt a tool that is already running", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
      const mcp = slideMcp(() => vi.setSystemTime(Date.now() + 100_000));

      // 1 回の応答で 2 件のツールを呼ぶ。2 件目を始める時点で 100 秒、終わると 200 秒。
      const { runEnd } = await run(
        (index) =>
          index === 0
            ? { toolCalls: [navigateCall("call_0", 0), navigateCall("call_1", 1)] }
            : { content: "回答です。" },
        mcp
      );

      expect(mcp.navigateTo).toHaveBeenCalledTimes(2);
      expect(runEnd).toMatchObject({ reason: "answered", exceededBudget: "time", toolCalls: 2 });
    });

    it("still ends with the limit error when the model never answers after the budget", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
      const mcp = slideMcp(() => vi.setSystemTime(Date.now() + 151_000));

      const { llm, result, runEnd } = await run(
        (index) => ({ toolCalls: [navigateCall(`call_${index}`, index)] }),
        mcp
      );

      expect(result).toBeInstanceOf(Error);
      expect(llm.requests).toHaveLength(10);
      expect(mcp.navigateTo).toHaveBeenCalledTimes(1);
      expect(runEnd).toMatchObject({ reason: "iteration_limit", exceededBudget: "time" });
    });
  });
});
