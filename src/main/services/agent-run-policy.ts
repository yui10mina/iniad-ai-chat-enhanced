/**
 * 1 回の実行（質問 1 件）の中で、何を許すかを決める。ループは決定を尋ねて従うだけにする。
 *
 * 決めること:
 *   - 反復ごとに、ツールを渡すか、Web 検索を含めるか、最終回答を促すか
 *   - ツール呼び出しごとに、実行してよいか（回数の上限、Web 検索の遮断）
 *
 * 状態（実行した回数、Web 検索を使えるか）はこの中だけで持つ。
 */
import { toolFailure, type ToolOutcome } from "./mcp-result";

/** AI への問い合わせの上限。最後の 2 回はツールを渡さず、回答だけを求める。 */
export const MAX_ITERATIONS = 10;
/** 1 回の実行で実際に実行するツール呼び出しの上限。 */
export const MAX_AGENT_TOOL_CALLS = 12;

/** 反復 1 回分の方針。 */
export interface IterationPlan {
  /** 最後の反復か */
  isLastIteration: boolean;
  /** ツールを渡さず、これまでの情報で回答させる段階か（最後の 2 回） */
  forceFinalAnswer: boolean;
  /** ツール呼び出しの上限に達しているか */
  toolBudgetExhausted: boolean;
  /** この反復でツールを渡すか */
  allowTools: boolean;
  /** 渡すツールに web_search を含めるか */
  allowWebSearch: boolean;
  /** 「ツールは使わず回答してください」という一文を足すか */
  finalAnswerHint: boolean;
}

/** ツール呼び出し 1 件の可否。拒否のときは、モデルに返す文と結果の種類を持つ。 */
export type ToolCallDecision =
  | { allowed: true }
  | { allowed: false; content: string; outcome: ToolOutcome };

export class AgentRunPolicy {
  private toolCallCount = 0;
  private webSearchAllowed: boolean;
  private mcpExplorationStarted = false;

  /**
   * @param hasReferenceMaterial 実行の最初から、信頼できない資料（過去の資料や索引のヒント）が
   *   プロンプトに入っているか。入っていれば、Web 検索は最初から使わせない。
   */
  constructor(options: { hasReferenceMaterial: boolean }) {
    // Do not expose an outward web-search capability after untrusted prior/current
    // material has influenced the model. A single initial search may still be used
    // for ordinary questions before any MCP browsing begins.
    this.webSearchAllowed = !options.hasReferenceMaterial;
  }

  /** これまでに実際に実行したツール呼び出しの数（拒否したものは含めない）。 */
  get executedToolCalls(): number {
    return this.toolCallCount;
  }

  /** @param iteration 0 始まりの反復の番号 */
  planIteration(iteration: number): IterationPlan {
    const isLastIteration = iteration === MAX_ITERATIONS - 1;
    const forceFinalAnswer = iteration >= MAX_ITERATIONS - 2;
    const toolBudgetExhausted = this.toolCallCount >= MAX_AGENT_TOOL_CALLS;
    return {
      isLastIteration,
      forceFinalAnswer,
      toolBudgetExhausted,
      allowTools: !forceFinalAnswer && !toolBudgetExhausted,
      allowWebSearch: this.webSearchAllowed && !this.mcpExplorationStarted,
      finalAnswerHint: isLastIteration || toolBudgetExhausted,
    };
  }

  /**
   * ツール呼び出しを実行してよいかを決める。許可したときは、回数と Web 検索の状態を
   * ここで進める。実行の前に進めるので、失敗した呼び出しも回数に入り、失敗した moocs_ の
   * 呼び出しのあとも Web 検索は使えなくなる。
   *
   * argsJson は今は判定に使わない。同じ呼び出しの繰り返しを検出するときに使う。
   */
  authorizeToolCall(toolName: string, argsJson: string): ToolCallDecision {
    void argsJson;
    if (this.toolCallCount >= MAX_AGENT_TOOL_CALLS) {
      return {
        allowed: false,
        content: `Error: total tool call limit (${MAX_AGENT_TOOL_CALLS}) reached`,
        outcome: toolFailure("tool_limit_reached"),
      };
    }
    if (toolName === "web_search" && (!this.webSearchAllowed || this.mcpExplorationStarted)) {
      return {
        allowed: false,
        content:
          "Error: web_search is unavailable after reference material or MCP output has been provided",
        outcome: toolFailure("web_search_blocked"),
      };
    }

    this.toolCallCount++;
    if (toolName.startsWith("moocs_")) this.mcpExplorationStarted = true;
    if (toolName === "web_search") this.webSearchAllowed = false;
    return { allowed: true };
  }
}
