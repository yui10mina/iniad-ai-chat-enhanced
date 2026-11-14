/**
 * 実行の方針（何回まで問い合わせるか、どのツールを許すか）のテスト。
 * ループを通した確認は chat-agent-limits と chat-agent-security にある。ここでは判定だけを見る。
 */
import { describe, expect, it } from "vitest";
import {
  AgentRunPolicy,
  MAX_AGENT_TOOL_CALLS,
  MAX_IDENTICAL_TOOL_CALLS,
  MAX_ITERATIONS,
  RUN_PROMPT_TOKEN_BUDGET,
  RUN_TIME_BUDGET_MS,
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

  describe("the same call repeated", () => {
    const SLIDE_A = "https://moocs.iniad.org/courses/2099/TEST101/01/01";
    const SLIDE_B = "https://moocs.iniad.org/courses/2099/TEST101/01/02";
    const read = (url: string) => JSON.stringify({ url });
    const REFUSED = {
      allowed: false,
      content:
        "Error: this exact tool call was already made twice with nothing changed in between. " +
        "Its result is in an earlier tool result. Use that result, or answer with what you have.",
      outcome: { ok: false, code: "repeated_call" },
    };
    const ALLOWED = { allowed: true };

    it("allows a call twice and refuses the third", () => {
      expect(MAX_IDENTICAL_TOOL_CALLS).toBe(2);
      const policy = freshPolicy();

      expect(policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A))).toEqual(ALLOWED);
      expect(policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A))).toEqual(ALLOWED);
      expect(policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A))).toEqual(REFUSED);
      expect(policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A))).toEqual(REFUSED);
    });

    it("does not count a refused repeat against the tool budget", () => {
      const policy = freshPolicy();
      for (let i = 0; i < 5; i++) policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A));

      expect(policy.executedToolCalls).toBe(2);
    });

    it("counts each URL and each tool on its own", () => {
      const policy = freshPolicy();
      policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A));
      policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A));

      expect(policy.authorizeToolCall("moocs_read_slide", read(SLIDE_B))).toEqual(ALLOWED);
      expect(policy.authorizeToolCall("moocs_navigate", read(SLIDE_A))).toEqual(ALLOWED);
    });

    it.each<{ name: string; args: string }>([
      { name: "a trailing slash", args: JSON.stringify({ url: `${SLIDE_A}/` }) },
      { name: "a fragment", args: JSON.stringify({ url: `${SLIDE_A}#top` }) },
      { name: "spaces around the URL", args: JSON.stringify({ url: `  ${SLIDE_A} ` }) },
      { name: "different spacing in the JSON", args: `{ "url" : "${SLIDE_A}" }` },
    ])("treats a call that differs only by $name as the same call", ({ args }) => {
      const policy = freshPolicy();
      policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A));
      policy.authorizeToolCall("moocs_read_slide", args);

      expect(policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A))).toEqual(REFUSED);
    });

    it("ignores the order of the arguments", () => {
      const policy = freshPolicy();
      policy.authorizeToolCall("unknown_tool", '{"a":1,"b":2}');
      policy.authorizeToolCall("unknown_tool", '{"b":2,"a":1}');

      expect(policy.authorizeToolCall("unknown_tool", '{"a":1,"b":2}')).toEqual(REFUSED);
      expect(policy.authorizeToolCall("unknown_tool", '{"a":1,"b":3}')).toEqual(ALLOWED);
    });

    it("counts a call with no target per page: the same call on another page is a new call", () => {
      const policy = freshPolicy();
      policy.authorizeToolCall("moocs_navigate", read(SLIDE_A));
      expect(policy.authorizeToolCall("moocs_list_slides", "{}")).toEqual(ALLOWED);
      expect(policy.authorizeToolCall("moocs_list_slides", "")).toEqual(ALLOWED);
      expect(policy.authorizeToolCall("moocs_list_slides", "{}")).toEqual(REFUSED);

      policy.authorizeToolCall("moocs_navigate", read(SLIDE_B));

      expect(policy.authorizeToolCall("moocs_list_slides", "{}")).toEqual(ALLOWED);
    });

    it("treats a read with a URL as moving to that page", () => {
      const policy = freshPolicy();
      policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A));
      policy.authorizeToolCall("moocs_page_content", "{}");
      policy.authorizeToolCall("moocs_page_content", "{}");

      policy.authorizeToolCall("moocs_read_slide", read(SLIDE_B));

      expect(policy.authorizeToolCall("moocs_page_content", "{}")).toEqual(ALLOWED);
    });

    it("does not treat a read without a URL as moving to another page", () => {
      const policy = freshPolicy();
      policy.authorizeToolCall("moocs_read_slide", "{}");
      policy.authorizeToolCall("moocs_read_slide", "{}");

      expect(policy.authorizeToolCall("moocs_read_slide", "{}")).toEqual(REFUSED);
    });

    // 計画の文面は「navigate を挟むとリセット」だが、URL つきの読み取りは数え続ける。
    // 同じ URL を 3 回読んでも、内容は同じで、得るものがないため。
    it("still counts a read of the same URL when other pages were opened in between", () => {
      const policy = freshPolicy();
      policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A));
      policy.authorizeToolCall("moocs_navigate", read(SLIDE_B));
      policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A));
      policy.authorizeToolCall("moocs_navigate", read(SLIDE_B));

      expect(policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A))).toEqual(REFUSED);
    });

    it.each(["moocs_login", "moocs_google_login"])(
      "starts counting again after %s, so a read that failed before the login can be retried",
      (loginTool) => {
        const policy = freshPolicy();
        policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A));
        policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A));
        policy.authorizeToolCall("moocs_list_slides", "{}");
        policy.authorizeToolCall("moocs_list_slides", "{}");

        expect(policy.authorizeToolCall(loginTool, "{}")).toEqual(ALLOWED);

        expect(policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A))).toEqual(ALLOWED);
        expect(policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A))).toEqual(ALLOWED);
        expect(policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A))).toEqual(REFUSED);
        expect(policy.authorizeToolCall("moocs_list_slides", "{}")).toEqual(ALLOWED);
      }
    );

    it("refuses the third login too, even though a login resets the other counts", () => {
      const policy = freshPolicy();

      expect(policy.authorizeToolCall("moocs_google_login", "{}")).toEqual(ALLOWED);
      expect(policy.authorizeToolCall("moocs_login", "{}")).toEqual(ALLOWED);
      expect(policy.authorizeToolCall("moocs_google_login", "{}")).toEqual(ALLOWED);
      expect(policy.authorizeToolCall("moocs_google_login", "{}")).toEqual(REFUSED);
      expect(policy.authorizeToolCall("moocs_login", "{}")).toEqual(ALLOWED);
      expect(policy.authorizeToolCall("moocs_login", "{}")).toEqual(REFUSED);
    });

    it("counts a call whose arguments are not valid JSON by its raw text", () => {
      const policy = freshPolicy();
      policy.authorizeToolCall("moocs_navigate", '{"url":');
      policy.authorizeToolCall("moocs_navigate", '{"url":');

      expect(policy.authorizeToolCall("moocs_navigate", '{"url":')).toEqual(REFUSED);
      expect(policy.authorizeToolCall("moocs_navigate", '{"url"')).toEqual(ALLOWED);
    });

    it("reports the budget, not the repeat, when both apply", () => {
      const policy = freshPolicy();
      policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A));
      policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A));
      useTools(policy, MAX_AGENT_TOOL_CALLS - 2, "unknown_tool");

      expect(policy.authorizeToolCall("moocs_read_slide", read(SLIDE_A))).toMatchObject({
        content: LIMIT_MESSAGE,
      });
    });

    it("leaves the plan for the next model call unchanged by a refused repeat", () => {
      const policy = freshPolicy();
      policy.authorizeToolCall("unknown_tool", "{}");
      policy.authorizeToolCall("unknown_tool", "{}");
      const before = policy.planIteration(1);

      policy.authorizeToolCall("unknown_tool", "{}");

      expect(policy.planIteration(1)).toEqual(before);
    });
  });

  describe("time and token budgets", () => {
    function clockPolicy() {
      let now = 1_000_000;
      const policy = new AgentRunPolicy({ hasReferenceMaterial: false, now: () => now });
      return { policy, advance: (ms: number) => (now += ms) };
    }
    const FORCED = { forceFinalAnswer: true, allowTools: false, finalAnswerHint: true };
    const NOT_FORCED = {
      forceFinalAnswer: false,
      allowTools: true,
      finalAnswerHint: false,
      exceededBudget: null,
    };

    it("has the budgets chosen from the recorded runs", () => {
      expect(RUN_TIME_BUDGET_MS).toBe(150_000);
      expect(RUN_PROMPT_TOKEN_BUDGET).toBe(60_000);
    });

    it("forces an answer from the moment the time budget is reached", () => {
      const { policy, advance } = clockPolicy();

      advance(149_999);
      expect(policy.planIteration(1)).toMatchObject(NOT_FORCED);

      advance(1);
      expect(policy.planIteration(1)).toMatchObject({ ...FORCED, exceededBudget: "time" });
    });

    it("measures time from when the run started, not from the previous call", () => {
      const { policy, advance } = clockPolicy();

      advance(100_000);
      policy.planIteration(1);
      advance(60_000);

      expect(policy.planIteration(2).exceededBudget).toBe("time");
    });

    it("forces an answer from the moment the prompt tokens reach the budget", () => {
      const { policy } = clockPolicy();

      policy.recordModelUsage({ promptTokens: 59_999 });
      expect(policy.planIteration(1)).toMatchObject(NOT_FORCED);

      policy.recordModelUsage({ promptTokens: 1 });
      expect(policy.planIteration(2)).toMatchObject({ ...FORCED, exceededBudget: "tokens" });
    });

    it.each<{ name: string; usage: { promptTokens: number | null } | null }>([
      { name: "no usage at all", usage: null },
      { name: "usage without a prompt token count", usage: { promptTokens: null } },
    ])("stops using the token budget for the run after $name", ({ usage }) => {
      const { policy, advance } = clockPolicy();
      policy.recordModelUsage({ promptTokens: 50_000 });

      policy.recordModelUsage(usage);
      policy.recordModelUsage({ promptTokens: 500_000 });

      expect(policy.planIteration(3)).toMatchObject(NOT_FORCED);
      // 時間の予算は、usage がなくても使う。
      advance(RUN_TIME_BUDGET_MS);
      expect(policy.planIteration(3).exceededBudget).toBe("time");
    });

    it("reports the time budget when both are exceeded", () => {
      const { policy, advance } = clockPolicy();
      policy.recordModelUsage({ promptTokens: RUN_PROMPT_TOKEN_BUDGET });
      advance(RUN_TIME_BUDGET_MS);

      expect(policy.planIteration(1).exceededBudget).toBe("time");
    });

    it("does not report a budget on the last two calls, which are forced anyway", () => {
      const { policy } = clockPolicy();

      expect(policy.planIteration(8)).toMatchObject({
        forceFinalAnswer: true,
        allowTools: false,
        exceededBudget: null,
        finalAnswerHint: false,
      });
    });

    it("does not change how tool calls are decided", () => {
      const { policy, advance } = clockPolicy();
      advance(RUN_TIME_BUDGET_MS);

      // 予算を超えたあとはツールを渡さないので、ここへ来るのはループが捨てるはずの呼び出しだけ。
      expect(policy.authorizeToolCall("moocs_navigate", NAVIGATE_ARGS)).toEqual({ allowed: true });
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
