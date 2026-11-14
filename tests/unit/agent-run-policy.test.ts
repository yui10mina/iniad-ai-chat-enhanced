/**
 * 実行の方針（何回まで問い合わせるか、どのツールを許すか）のテスト。
 * ループを通した確認は chat-agent-limits と chat-agent-security にある。ここでは判定だけを見る。
 */
import { describe, expect, it } from "vitest";
import {
  AgentRunPolicy,
  MAX_AGENT_TOOL_CALLS,
  MAX_ITERATIONS,
} from "../../src/main/services/agent-run-policy";

const NAVIGATE_ARGS = '{"url":"https://moocs.iniad.org/courses/2099/TEST101"}';
const LIMIT_MESSAGE = "Error: total tool call limit (12) reached";
const WEB_SEARCH_MESSAGE =
  "Error: web_search is unavailable after reference material or MCP output has been provided";

function freshPolicy(hasReferenceMaterial = false): AgentRunPolicy {
  return new AgentRunPolicy({ hasReferenceMaterial });
}

/** n 件のツール呼び出しを許可させる。毎回ちがう引数にする。 */
function useTools(policy: AgentRunPolicy, count: number, toolName = "moocs_navigate"): void {
  for (let i = 0; i < count; i++) {
    expect(policy.authorizeToolCall(toolName, `{"n":${i}}`)).toEqual({ allowed: true });
  }
}

describe("AgentRunPolicy", () => {
  it("has the limits the loop tests rely on", () => {
    expect(MAX_ITERATIONS).toBe(10);
    expect(MAX_AGENT_TOOL_CALLS).toBe(12);
  });

  describe("planIteration", () => {
    it("offers tools for the first eight calls and forces an answer on the last two", () => {
      const policy = freshPolicy();

      const plans = Array.from({ length: MAX_ITERATIONS }, (_, i) => policy.planIteration(i));

      expect(plans.map((plan) => plan.allowTools)).toEqual([
        ...Array<boolean>(8).fill(true),
        false,
        false,
      ]);
      expect(plans.map((plan) => plan.forceFinalAnswer)).toEqual([
        ...Array<boolean>(8).fill(false),
        true,
        true,
      ]);
      // 回答を促す一文は、最後の 1 回だけに足す（9 回目はツールを渡さないだけ）。
      expect(plans.map((plan) => plan.finalAnswerHint)).toEqual([
        ...Array<boolean>(9).fill(false),
        true,
      ]);
      expect(plans.map((plan) => plan.isLastIteration)).toEqual([
        ...Array<boolean>(9).fill(false),
        true,
      ]);
    });

    it("stops offering tools and asks for an answer once the tool budget is used up", () => {
      const policy = freshPolicy();
      useTools(policy, MAX_AGENT_TOOL_CALLS - 1);
      expect(policy.planIteration(2)).toMatchObject({
        toolBudgetExhausted: false,
        allowTools: true,
        finalAnswerHint: false,
      });

      useTools(policy, 1);

      expect(policy.planIteration(2)).toMatchObject({
        toolBudgetExhausted: true,
        allowTools: false,
        finalAnswerHint: true,
        forceFinalAnswer: false,
      });
    });

    it("does not change anything by being asked", () => {
      const policy = freshPolicy();

      const first = policy.planIteration(0);
      policy.planIteration(9);

      expect(policy.planIteration(0)).toEqual(first);
      expect(policy.executedToolCalls).toBe(0);
    });
  });

  describe("web_search", () => {
    it("is offered and allowed once when the run starts without reference material", () => {
      const policy = freshPolicy();

      expect(policy.planIteration(0).allowWebSearch).toBe(true);
      expect(policy.authorizeToolCall("web_search", '{"query":"a"}')).toEqual({ allowed: true });

      expect(policy.planIteration(1).allowWebSearch).toBe(false);
      expect(policy.authorizeToolCall("web_search", '{"query":"b"}')).toEqual({
        allowed: false,
        content: WEB_SEARCH_MESSAGE,
        outcome: { ok: false, code: "web_search_blocked" },
      });
    });

    it("is never offered or allowed when the run starts with reference material", () => {
      const policy = freshPolicy(true);

      expect(policy.planIteration(0).allowWebSearch).toBe(false);
      expect(policy.authorizeToolCall("web_search", '{"query":"a"}')).toMatchObject({
        allowed: false,
        content: WEB_SEARCH_MESSAGE,
      });
      // MOOCs のツールは、資料があっても使える。
      expect(policy.authorizeToolCall("moocs_navigate", NAVIGATE_ARGS)).toEqual({ allowed: true });
    });

    it.each(["moocs_login", "moocs_navigate", "moocs_read_slide", "moocs_page_content"])(
      "is closed after %s is allowed, whether or not that call then succeeds",
      (toolName) => {
        const policy = freshPolicy();

        expect(policy.authorizeToolCall(toolName, "{}")).toEqual({ allowed: true });

        expect(policy.planIteration(1).allowWebSearch).toBe(false);
        expect(policy.authorizeToolCall("web_search", '{"query":"a"}')).toMatchObject({
          allowed: false,
          outcome: { ok: false, code: "web_search_blocked" },
        });
      }
    );

    it("stays open after a tool that is neither MOOCs nor web_search", () => {
      const policy = freshPolicy();

      expect(policy.authorizeToolCall("unknown_tool", "{}")).toEqual({ allowed: true });

      expect(policy.planIteration(1).allowWebSearch).toBe(true);
    });

    it("does not count a refused web_search against the tool budget", () => {
      const policy = freshPolicy(true);

      policy.authorizeToolCall("web_search", '{"query":"a"}');
      policy.authorizeToolCall("web_search", '{"query":"b"}');

      expect(policy.executedToolCalls).toBe(0);
    });
  });

  describe("tool budget", () => {
    it("allows twelve calls and refuses the thirteenth with the fixed message", () => {
      const policy = freshPolicy();

      useTools(policy, MAX_AGENT_TOOL_CALLS);

      expect(policy.executedToolCalls).toBe(12);
      expect(policy.authorizeToolCall("moocs_navigate", NAVIGATE_ARGS)).toEqual({
        allowed: false,
        content: LIMIT_MESSAGE,
        outcome: { ok: false, code: "tool_limit_reached" },
      });
      expect(policy.executedToolCalls).toBe(12);
    });

    it("counts a call when it is allowed, before it runs", () => {
      const policy = freshPolicy();

      policy.authorizeToolCall("moocs_navigate", "not json");

      // 引数が壊れていて実行時に失敗する呼び出しも、許可した時点で 1 回に数える。
      expect(policy.executedToolCalls).toBe(1);
    });

    it("reports the limit, not the web_search rule, for a web_search over the budget", () => {
      const policy = freshPolicy();
      useTools(policy, MAX_AGENT_TOOL_CALLS, "unknown_tool");

      expect(policy.authorizeToolCall("web_search", '{"query":"a"}')).toMatchObject({
        allowed: false,
        content: LIMIT_MESSAGE,
      });
    });
  });

  it("keeps separate state for each run", () => {
    const first = freshPolicy();
    useTools(first, MAX_AGENT_TOOL_CALLS);

    const second = freshPolicy();

    expect(second.executedToolCalls).toBe(0);
    expect(second.planIteration(0)).toMatchObject({ allowTools: true, allowWebSearch: true });
    expect(second.authorizeToolCall("web_search", '{"query":"a"}')).toEqual({ allowed: true });
  });
});
