import type { Citation } from "../../shared/types/chat";
import { collectCitationsFromText } from "./moocs-citations";

export const MAX_TOOL_RESULT_CHARS = 4_000;
const TRUNCATE_SUFFIX = "\n...(truncated)";

export function truncate(text: string, maxChars = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= maxChars) return text;
  // サフィックス長を差し引いて切り詰め、戻り値が maxChars を超えないようにする
  return text.slice(0, Math.max(0, maxChars - TRUNCATE_SUFFIX.length)) + TRUNCATE_SUFFIX;
}

export function mcpResultToText(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");

  const typed = result as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };

  if (typed.isError) {
    const errText = typed.content?.map((c) => c.text).join("\n") ?? "Unknown MCP error";
    return `Error: ${errText}`;
  }

  if (typed.content && Array.isArray(typed.content)) {
    return typed.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
  }

  return JSON.stringify(result);
}

/** ツールが失敗した理由。生のエラー文は入れず、決まった値だけを使う。 */
export type ToolFailureCode =
  /** 引数が JSON でない、形が違う、MOOCs 以外の URL など */
  | "invalid_arguments"
  | "unknown_tool"
  | "blocked_tool"
  /** 1 回の質問で使えるツール回数の上限 */
  | "tool_limit_reached"
  /** 資料や MCP の出力を読んだあとの web_search */
  | "web_search_blocked"
  /** 同じ呼び出しを、同じ状況で繰り返しすぎた */
  | "repeated_call"
  | "mcp_not_connected"
  | "mcp_connection_lost"
  /** MCP がエラーとして返した結果 */
  | "mcp_error"
  | "google_login_required"
  /** スライド抽出がエラーを返した */
  | "slide_extract_failed"
  /** ページやスライドから本文を取り出せなかった */
  | "content_unavailable"
  | "web_search_failed"
  /** 実行中に例外が起きた */
  | "exception";

/**
 * ツール実行の結果の種類。content の文字列を読まずに成否を判定するために使う。
 * not_published は非公開のページを読めた場合、no_results は検索結果が 0 件だった場合。
 */
export type ToolOutcome =
  | { ok: true; code: "ok" | "not_published" | "no_results" }
  | { ok: false; code: ToolFailureCode };

export const TOOL_OK: ToolOutcome = { ok: true, code: "ok" };

export function toolFailure(code: ToolFailureCode): ToolOutcome {
  return { ok: false, code };
}

export interface ToolExecutionResult {
  content: string;
  citations: Citation[];
  outcome: ToolOutcome;
}

export function isMcpErrorResult(result: unknown): boolean {
  return (
    !!result && typeof result === "object" && (result as { isError?: unknown }).isError === true
  );
}

export function formatMcpResult(result: unknown, citations: Citation[]): ToolExecutionResult {
  const content = mcpResultToText(result);
  collectCitationsFromText(content, citations);
  return {
    content: truncate(content),
    citations,
    outcome: isMcpErrorResult(result) ? toolFailure("mcp_error") : TOOL_OK,
  };
}
