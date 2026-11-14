/**
 * 1 回の実行（質問 1 件）の中で、何を許すかを決める。ループは決定を尋ねて従うだけにする。
 *
 * 決めること:
 *   - 反復ごとに、ツールを渡すか、Web 検索を含めるか、最終回答を促すか
 *   - ツール呼び出しごとに、実行してよいか（回数の上限、Web 検索の遮断、同じ呼び出しの繰り返し）
 *
 * 状態（実行した回数、Web 検索を使えるか、何を何回呼んだか）はこの中だけで持つ。
 */
import { toolFailure, type ToolOutcome } from "./mcp-result";

/** AI への問い合わせの上限。最後の 2 回はツールを渡さず、回答だけを求める。 */
export const MAX_ITERATIONS = 10;
/** 1 回の実行で実際に実行するツール呼び出しの上限。 */
export const MAX_AGENT_TOOL_CALLS = 12;
/**
 * 同じ呼び出しを同じ状況で実行してよい回数。3 回目から拒否する。
 * 読み直しを 1 回は許す（本文が文脈から省略されていて、読み直しが必要なことがある）。
 */
export const MAX_IDENTICAL_TOOL_CALLS = 2;

/** ログインの状態を変えるツール。成功すると、それまで失敗していた呼び出しが通るようになり得る。 */
const LOGIN_TOOLS: ReadonlySet<string> = new Set(["moocs_login", "moocs_google_login"]);

const REPEATED_CALL_MESSAGE =
  "Error: this exact tool call was already made twice with nothing changed in between. " +
  "Its result is in an earlier tool result. Use that result, or answer with what you have.";

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
  /** 呼び出しごとの、許可した回数。ログインすると消す。 */
  private identicalCallCounts = new Map<string, number>();
  /** 開いているページが変わるたびに進む番号。URL を取らない呼び出しの区別に使う。 */
  private pageEpoch = 0;

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
   * 同じ呼び出しの繰り返し:
   *   - 「同じ」とは、ツール名と引数が同じこと。URL や検索語を取らない呼び出し（一覧の取得など）は、
   *     開いているページが同じあいだだけ同じと見なす。ページを移ったあとの同じ呼び出しは別のもの。
   *   - 3 回目から拒否する。拒否した呼び出しは回数の上限には数えない。
   *   - ログイン（moocs_login、moocs_google_login）を許可したら、数え直す。ログインの前に
   *     失敗した読み取りを、ログイン後にやり直すのは正当な再試行なので止めない。
   */
  authorizeToolCall(toolName: string, argsJson: string): ToolCallDecision {
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

    const args = parseToolArgs(argsJson);
    const callKey = this.identicalCallKey(toolName, args);
    const previousCalls = this.identicalCallCounts.get(callKey) ?? 0;
    if (previousCalls >= MAX_IDENTICAL_TOOL_CALLS) {
      return {
        allowed: false,
        content: REPEATED_CALL_MESSAGE,
        outcome: toolFailure("repeated_call"),
      };
    }

    this.toolCallCount++;
    if (toolName.startsWith("moocs_")) this.mcpExplorationStarted = true;
    if (toolName === "web_search") this.webSearchAllowed = false;

    if (LOGIN_TOOLS.has(toolName)) {
      // ログインそのものの繰り返しは数え続ける。ほかの呼び出しは数え直す。
      const loginCounts = [...this.identicalCallCounts].filter(([key]) =>
        LOGIN_TOOLS.has(key.split(KEY_SEPARATOR)[0])
      );
      this.identicalCallCounts = new Map(loginCounts);
    }
    this.identicalCallCounts.set(callKey, previousCalls + 1);
    // ログインと、URL を開く呼び出しのあとは、開いているページが変わっている。
    if (LOGIN_TOOLS.has(toolName) || hasTarget(args, "url")) this.pageEpoch++;
    return { allowed: true };
  }

  private identicalCallKey(toolName: string, args: ParsedToolArgs): string {
    if (LOGIN_TOOLS.has(toolName)) return toolName;
    const target = hasTarget(args, "url") || hasTarget(args, "query");
    // 行き先のない呼び出しは、いま開いているページに対するものとして区別する。
    return [toolName, target ? args.key : `page#${this.pageEpoch}:${args.key}`].join(KEY_SEPARATOR);
  }
}

const KEY_SEPARATOR = "\u0000";

interface ParsedToolArgs {
  /** 引数を、キーの順序や URL 末尾のスラッシュに左右されない形にしたもの */
  key: string;
  values: Record<string, unknown> | null;
}

function parseToolArgs(argsJson: string): ParsedToolArgs {
  let parsed: unknown;
  try {
    parsed = argsJson.trim() ? JSON.parse(argsJson) : {};
  } catch {
    // JSON として読めない引数は、文字列のまま比べる（同じ壊れ方の繰り返しも数える）。
    return { key: `raw:${argsJson.trim()}`, values: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { key: `raw:${JSON.stringify(parsed)}`, values: null };
  }
  const values = parsed as Record<string, unknown>;
  const normalized = Object.keys(values)
    .sort()
    .map((name) => [name, normalizeArgValue(name, values[name])]);
  return { key: JSON.stringify(normalized), values };
}

function normalizeArgValue(name: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  // 末尾のスラッシュとフラグメントの違いだけなら、同じページ。
  return name === "url" ? trimmed.replace(/#.*$/, "").replace(/\/+$/, "") : trimmed;
}

function hasTarget(args: ParsedToolArgs, name: "url" | "query"): boolean {
  const value = args.values?.[name];
  return typeof value === "string" && value.trim().length > 0;
}
