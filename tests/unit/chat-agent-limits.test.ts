/**
 * エージェントのループ上限の「今の動き」を固定するテスト。
 * 本番コードは変えず、API に送った body と chat の戻り値だけを見る。
 * finish_reason は PR8 で判定するようになった。途中で終わった回答は本文を変えずに completion で知らせる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAgent } from "../../src/main/services/chat-agent";
import type { McpClient } from "../../src/main/services/mcp-client";
import type { IWebSearchProvider } from "../../src/main/services/web-search-types";
import type { AppSettings } from "../../src/shared/types/settings";
import {
  installFakeLlm,
  lastMessage,
  navigateCall,
  toolNames,
  type SentRequest,
} from "../helpers/fake-llm";

const settings: AppSettings = {
  apiKey: "test-key",
  baseURL: "https://api.openai.iniad.org/api/v1",
  model: "gpt-test",
  moocsUsername: "",
  moocsPassword: "",
};

// 上限の値そのものも固定するため、本番の定数を import せずに書く。
const MAX_ITERATIONS = 10;
const MAX_AGENT_TOOL_CALLS = 12;
const FINAL_ANSWER_HINT =
  "十分な情報が集まりました。ツールは使わず、これまでの調査結果だけを使って日本語で回答してください。";
const FORCED_CONTINUE_MESSAGE =
  "ツールの追加呼び出しは不要です。これまでに取得した情報だけを使って、日本語で回答してください。";

function connectedMcp(): McpClient {
  return {
    getStatus: vi.fn().mockReturnValue("connected"),
    ping: vi.fn().mockResolvedValue(true),
    navigateTo: vi.fn().mockResolvedValue(undefined),
  } as unknown as McpClient;
}

const webClient: IWebSearchProvider = { search: vi.fn() };

function toolMessages(request: SentRequest) {
  return request.messages.filter((message) => message.role === "tool");
}

function assistantToolCallIds(request: SentRequest): string[] {
  return request.messages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []);
}

describe("ChatAgent loop limits (current behaviour)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("when the model keeps calling tools", () => {
    async function runUntilLimit() {
      // 毎回、URL を変えた moocs_navigate を 1 件だけ呼び続ける。
      const llm = installFakeLlm((index) => ({
        toolCalls: [navigateCall(`call_${index}`, index)],
      }));
      const mcp = connectedMcp();
      const agent = new ChatAgent(mcp, webClient);
      const error = await agent.chat("質問", settings).catch((e: unknown) => e);
      return { llm, mcp, error };
    }

    it("sends tools in requests 1-8 and none in requests 9 and 10", async () => {
      const { llm } = await runUntilLimit();

      expect(llm.requests).toHaveLength(MAX_ITERATIONS);
      llm.requests.slice(0, 8).forEach((request, i) => {
        expect(toolNames(request), `request ${i + 1}`).toContain("moocs_navigate");
        expect(request.tool_choice, `request ${i + 1}`).toBe("auto");
      });
      llm.requests.slice(8).forEach((request, i) => {
        expect(request, `request ${i + 9}`).not.toHaveProperty("tools");
        expect(request, `request ${i + 9}`).not.toHaveProperty("tool_choice");
      });
    });

    it("adds the final-answer hint only to the last request", async () => {
      const { llm } = await runUntilLimit();

      llm.requests.slice(0, 9).forEach((request, i) => {
        expect(lastMessage(request).content, `request ${i + 1}`).not.toBe(FINAL_ANSWER_HINT);
      });
      expect(lastMessage(llm.requests[9])).toEqual({ role: "user", content: FINAL_ANSWER_HINT });
    });

    it("does not run tool calls returned while a final answer is forced, and asks again in a user message", async () => {
      const { llm, mcp } = await runUntilLimit();

      // 8 回目までの呼び出しは実行され、その結果が 9 回目のリクエストに載る。
      expect(toolMessages(llm.requests[8])).toHaveLength(8);
      expect(assistantToolCallIds(llm.requests[8])).toEqual(
        Array.from({ length: 8 }, (_, i) => `call_${i}`)
      );

      // 9・10 回目の応答の tool_calls は実行されない。
      expect(mcp.navigateTo).toHaveBeenCalledTimes(8);

      // 9 回目の応答は記録されず、user メッセージで回答を促すだけ。10 回目のリクエストは
      // 9 回目と同じ履歴に、その user メッセージと最終回答のヒントを足したものになる。
      const tenth = llm.requests[9];
      expect(tenth.messages.slice(0, -2)).toEqual(llm.requests[8].messages);
      expect(tenth.messages.at(-2)).toEqual({ role: "user", content: FORCED_CONTINUE_MESSAGE });
    });

    it("gives up with an error after 10 requests", async () => {
      const { llm, error } = await runUntilLimit();

      expect(llm.requests).toHaveLength(MAX_ITERATIONS);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "ツール呼び出しが 10 回を超えました。質問を分割して再度お試しください。"
      );
    });
  });

  describe("tool call budget", () => {
    it(`answers the call after the first ${MAX_AGENT_TOOL_CALLS} with an error and keeps every tool_call_id paired`, async () => {
      const batch = Array.from({ length: MAX_AGENT_TOOL_CALLS + 1 }, (_, i) =>
        navigateCall(`call_${i + 1}`, i + 1)
      );
      const llm = installFakeLlm((index) =>
        index === 0 ? { toolCalls: batch } : { content: "回答です。" }
      );
      const mcp = connectedMcp();
      const agent = new ChatAgent(mcp, webClient);

      const result = await agent.chat("質問", settings);

      expect(result.content).toBe("回答です。");
      // 実行されたのは最初の 12 件だけ。
      expect(mcp.navigateTo).toHaveBeenCalledTimes(MAX_AGENT_TOOL_CALLS);
      expect(vi.mocked(mcp.navigateTo).mock.calls.at(-1)?.[0]).toBe(
        `https://moocs.iniad.org/courses/2026/TEST/${MAX_AGENT_TOOL_CALLS}`
      );

      const second = llm.requests[1];
      const results = toolMessages(second);
      // すべての tool_call_id に、同じ順で結果が 1 件ずつ対応する。
      expect(results.map((message) => message.tool_call_id)).toEqual(batch.map((call) => call.id));
      // API に送るときは直近 2 件以外の本文が省略されるので、本文は最後の 2 件だけ見る。
      expect(results[MAX_AGENT_TOOL_CALLS - 1].content).toContain(
        `Navigated to https://moocs.iniad.org/courses/2026/TEST/${MAX_AGENT_TOOL_CALLS}`
      );
      expect(results[MAX_AGENT_TOOL_CALLS].content).toContain(
        `Error: total tool call limit (${MAX_AGENT_TOOL_CALLS}) reached`
      );
      expect(results[MAX_AGENT_TOOL_CALLS].content).not.toContain("Navigated to");
    });

    it("stops offering tools and adds the final-answer hint once the budget is used up", async () => {
      // 2 件ずつ 6 回で上限の 12 件に届く。7 回目のリクエストではツールを出さない。
      const llm = installFakeLlm((index) =>
        index < 6
          ? {
              toolCalls: [
                navigateCall(`a_${index}`, index * 2),
                navigateCall(`b_${index}`, index * 2 + 1),
              ],
            }
          : { content: "回答です。" }
      );
      const agent = new ChatAgent(connectedMcp(), webClient);

      await expect(agent.chat("質問", settings)).resolves.toMatchObject({ content: "回答です。" });

      expect(llm.requests).toHaveLength(7);
      llm.requests.slice(0, 6).forEach((request, i) => {
        expect(toolNames(request), `request ${i + 1}`).toContain("moocs_navigate");
        expect(lastMessage(request).content, `request ${i + 1}`).not.toBe(FINAL_ANSWER_HINT);
      });
      expect(llm.requests[6]).not.toHaveProperty("tools");
      expect(lastMessage(llm.requests[6])).toEqual({ role: "user", content: FINAL_ANSWER_HINT });
      expect(toolMessages(llm.requests[6])).toHaveLength(MAX_AGENT_TOOL_CALLS);
    });

    it("does not run tool calls returned after the budget is used up, and asks again in a user message", async () => {
      const batch = Array.from({ length: MAX_AGENT_TOOL_CALLS }, (_, i) =>
        navigateCall(`call_${i + 1}`, i + 1)
      );
      const llm = installFakeLlm((index) => {
        if (index === 0) return { toolCalls: batch };
        // 上限に達した後も、モデルがツールを呼ぼうとする。
        if (index === 1) return { toolCalls: [navigateCall("extra", 99)] };
        return { content: "回答です。" };
      });
      const mcp = connectedMcp();
      const agent = new ChatAgent(mcp, webClient);

      await expect(agent.chat("質問", settings)).resolves.toMatchObject({ content: "回答です。" });

      expect(llm.requests).toHaveLength(3);
      expect(mcp.navigateTo).toHaveBeenCalledTimes(MAX_AGENT_TOOL_CALLS);
      const [, second, third] = llm.requests;
      for (const request of [second, third]) {
        expect(request).not.toHaveProperty("tools");
        expect(lastMessage(request)).toEqual({ role: "user", content: FINAL_ANSWER_HINT });
      }
      // 2 回目の応答は記録されず、ヒントを除いた同じ履歴に user メッセージが足されるだけ。
      expect(third.messages.slice(0, -2)).toEqual(second.messages.slice(0, -1));
      expect(third.messages.at(-2)).toEqual({ role: "user", content: FORCED_CONTINUE_MESSAGE });
      expect(assistantToolCallIds(third)).not.toContain("extra");
    });
  });

  describe("finish_reason", () => {
    it.each<{ finishReason: string | null; name: string }>([
      { finishReason: "stop", name: "stop" },
      { finishReason: null, name: "missing" },
      { finishReason: "something_new", name: "an unknown value" },
    ])(
      "returns a complete answer without a completion field when finish_reason is $name",
      async ({ finishReason }) => {
        installFakeLlm(() => ({ content: "回答です。", finishReason }));
        const agent = new ChatAgent(connectedMcp(), webClient);

        const result = await agent.chat("質問", settings);

        expect(result.content).toBe("回答です。");
        expect(Object.keys(result).sort()).toEqual(["citations", "content", "latencyMs"]);
      }
    );

    it.each<{ finishReason: string; completion: string }>([
      { finishReason: "length", completion: "truncated" },
      { finishReason: "content_filter", completion: "filtered" },
    ])(
      "returns the text unchanged and marks it $completion when finish_reason is $finishReason",
      async ({ finishReason, completion }) => {
        installFakeLlm(() => ({ content: "途中で終わった回答", finishReason }));
        const agent = new ChatAgent(connectedMcp(), webClient);

        const result = await agent.chat("質問", settings);

        expect(result.content).toBe("途中で終わった回答");
        expect(result.completion).toBe(completion);
        expect(Object.keys(result).sort()).toEqual([
          "citations",
          "completion",
          "content",
          "latencyMs",
        ]);
      }
    );

    it.each<{ finishReason: string | null; message: string }>([
      {
        finishReason: "length",
        message: "回答が出力の上限に達し、本文が返りませんでした。質問を分けて再度お試しください。",
      },
      {
        finishReason: "content_filter",
        message: "回答がコンテンツフィルタで止められ、本文が返りませんでした。",
      },
      { finishReason: "stop", message: "API が空の回答を返しました" },
      { finishReason: null, message: "API が空の回答を返しました" },
    ])(
      "rejects an empty reply with finish_reason $finishReason",
      async ({ finishReason, message }) => {
        installFakeLlm(() => ({ content: "  ", finishReason }));
        const agent = new ChatAgent(connectedMcp(), webClient);

        await expect(agent.chat("質問", settings)).rejects.toThrow(new Error(message));
      }
    );

    // 強制された最終回答でも、印を付けるかどうかは finish_reason だけで決まる。
    it.each<{ finishReason: string; keys: string[] }>([
      { finishReason: "length", keys: ["citations", "completion", "content", "latencyMs"] },
      { finishReason: "stop", keys: ["citations", "content", "latencyMs"] },
    ])(
      "marks the forced final answer only by finish_reason ($finishReason)",
      async ({ finishReason, keys }) => {
        // 8 回ツールを呼び続け、9 回目（ツールなし）で回答する。
        const llm = installFakeLlm((index) =>
          index < 8
            ? { toolCalls: [navigateCall(`call_${index}`, index)] }
            : { content: "回答です。", finishReason }
        );
        const agent = new ChatAgent(connectedMcp(), webClient);

        const result = await agent.chat("質問", settings);

        expect(llm.requests).toHaveLength(9);
        expect(llm.requests[8]).not.toHaveProperty("tools");
        expect(Object.keys(result).sort()).toEqual(keys);
      }
    );

    // 切れた tool_calls の扱いは今の動きのまま。引数ごとに executor が判定する。
    it("does not run a tool call whose JSON arguments were cut off, but runs the complete ones", async () => {
      const llm = installFakeLlm((index) =>
        index === 0
          ? {
              finishReason: "length",
              toolCalls: [
                navigateCall("complete", 1),
                {
                  id: "cut",
                  name: "moocs_navigate",
                  arguments: '{"url":"https://moocs.iniad.org/cour',
                },
              ],
            }
          : { content: "回答です。" }
      );
      const mcp = connectedMcp();
      const agent = new ChatAgent(mcp, webClient);

      await expect(agent.chat("質問", settings)).resolves.toMatchObject({ content: "回答です。" });

      expect(mcp.navigateTo).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mcp.navigateTo).mock.calls[0]?.[0]).toBe(
        "https://moocs.iniad.org/courses/2026/TEST/1"
      );
      const results = toolMessages(llm.requests[1]);
      expect(results.map((message) => message.tool_call_id)).toEqual(["complete", "cut"]);
      expect(results[1].content).toContain("Error: tool arguments must be valid JSON");
    });

    it("runs a tool call cut off with empty arguments as if it had none", async () => {
      const callToolSafe = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "コース一覧" }],
      });
      installFakeLlm((index) =>
        index === 0
          ? {
              finishReason: "length",
              toolCalls: [{ id: "empty", name: "moocs_list_courses", arguments: "" }],
            }
          : { content: "回答です。" }
      );
      const mcp = { ...connectedMcp(), callToolSafe } as unknown as McpClient;
      const agent = new ChatAgent(mcp, webClient);

      await agent.chat("質問", settings);

      expect(callToolSafe).toHaveBeenCalledWith("listCourses", undefined, undefined, undefined);
    });
  });
});
