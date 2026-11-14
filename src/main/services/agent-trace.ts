/**
 * エージェントの 1 回の実行を、あとから説明できるようにするためのイベント。
 *
 * 質問文、回答、教材の本文、検索語、エラー文は記録しない。記録するのは、
 * 件数・長さ・時間と、決まった値（ツール名、outcome、終了理由）だけにする。
 * 引数はそのまま載せず、許可した項目だけを取り出す（traceToolArgs）。
 */

import { ApiRequestError } from "./api-client";
import type { ToolOutcome } from "./mcp-result";

/** 実行がどう終わったか。 */
export type AgentRunEndReason =
  /** 最後まで書かれた回答を返した */
  | "answered"
  /** 回答を返したが、出力の上限やフィルタで途中までだった */
  | "answer_incomplete"
  /** 反復の上限に達して回答できなかった */
  | "iteration_limit"
  | "cancelled"
  | "error";

/** 失敗の種類。エラー文は入れない。 */
export type AgentRunErrorKind =
  | "http"
  | "network"
  | "timeout"
  | "invalid-response"
  | "empty-answer"
  | "other";

export interface TraceUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

/** ツール引数のうち、記録してよい項目。 */
export interface TraceToolArgs {
  /** 引数の JSON 文字列の長さ */
  argsChars: number;
  /** MOOCs の URL のパスだけ。クエリとフラグメントは落とす。 */
  urlPath?: string;
  /** MOOCs 以外、または URL として読めない値が渡された */
  urlRejected?: true;
  /** 検索語の長さ。検索語そのものは記録しない。 */
  queryChars?: number;
}

export type AgentTraceEvent =
  | {
      type: "run_start";
      at: number;
      historyTurns: number;
      priorMaterials: number;
      hasSyllabusHint: boolean;
    }
  | {
      type: "llm_start";
      at: number;
      iteration: number;
      maxIterations: number;
      messageCount: number;
      payloadChars: number;
      toolsOffered: boolean;
      webSearchOffered: boolean;
      forcedFinal: boolean;
    }
  | {
      type: "llm_end";
      at: number;
      iteration: number;
      durationMs: number;
      finishReason: string | null;
      usage: TraceUsage | null;
      toolCalls: number;
      /** ツール呼び出しが返ったが、最終回答を求める段階だったので実行しなかった */
      toolCallsDiscarded: boolean;
      contentChars: number;
    }
  | {
      type: "tool_start";
      at: number;
      iteration: number;
      /** この実行で何件目のツール呼び出しか（1 始まり。拒否されたものも数える） */
      sequence: number;
      tool: string;
      args: TraceToolArgs;
    }
  | {
      type: "tool_end";
      at: number;
      iteration: number;
      sequence: number;
      tool: string;
      durationMs: number;
      outcome: ToolOutcome;
      resultChars: number;
      citations: number;
      materials: number;
    }
  | {
      type: "run_end";
      at: number;
      durationMs: number;
      reason: AgentRunEndReason;
      errorKind?: AgentRunErrorKind;
      httpStatus?: number;
      iterations: number;
      /** 実際に実行したツール呼び出しの数（拒否したものは含めない） */
      toolCalls: number;
      answerChars: number;
      citations: number;
      /** 時間かトークンの予算を超えて、調査を打ち切って回答させた場合の、超えた予算 */
      exceededBudget?: "time" | "tokens";
    };

/** `at` を除いたイベント。発行する側は時刻を付けない。 */
export type AgentTraceEventInput = AgentTraceEvent extends infer E
  ? E extends AgentTraceEvent
    ? Omit<E, "at">
    : never
  : never;

export type AgentTraceSink = (event: AgentTraceEvent) => void;
export type AgentTraceEmitter = (event: AgentTraceEventInput) => void;

/**
 * 登録された sink すべてへイベントを渡す。sink が例外を投げても、ほかの sink と
 * 回答の生成は止めない。
 */
export function createTraceEmitter(
  sinks: readonly AgentTraceSink[] | undefined,
  now: () => number = Date.now
): AgentTraceEmitter {
  if (!sinks?.length) return () => undefined;
  return (input) => {
    const event = { ...input, at: now() } as AgentTraceEvent;
    for (const sink of sinks) {
      try {
        sink(event);
      } catch {
        // 記録の失敗で回答を止めない。
      }
    }
  };
}

const MOOCS_HOST = "moocs.iniad.org";
const MAX_TRACE_PATH_CHARS = 200;
const MAX_TRACE_TOOL_NAME_CHARS = 40;

/**
 * モデルが返したツール名を、記録してよい形にする。知っている名前はそのまま、
 * それ以外は "unknown" にする（モデルの出力をそのまま残さない）。
 */
export function traceToolName(toolName: string, knownTools: ReadonlySet<string>): string {
  return knownTools.has(toolName) && toolName.length <= MAX_TRACE_TOOL_NAME_CHARS
    ? toolName
    : "unknown";
}

/** ツール引数から、記録してよい項目だけを取り出す。 */
export function traceToolArgs(argsJson: string): TraceToolArgs {
  const traced: TraceToolArgs = { argsChars: argsJson.length };
  let args: unknown;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return traced;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return traced;

  const { url, query } = args as { url?: unknown; query?: unknown };
  if (url !== undefined) {
    const path = moocsPathOf(url);
    if (path === null) traced.urlRejected = true;
    else traced.urlPath = path;
  }
  if (typeof query === "string") traced.queryChars = query.length;
  return traced;
}

function moocsPathOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== MOOCS_HOST) return null;
    return parsed.pathname.slice(0, MAX_TRACE_PATH_CHARS);
  } catch {
    return null;
  }
}

/** API の usage を、数値だけにして取り出す。なければ null。 */
export function traceUsage(usage: unknown): TraceUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const raw = usage as Record<string, unknown>;
  const numberOrNull = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const traced: TraceUsage = {
    promptTokens: numberOrNull(raw.prompt_tokens),
    completionTokens: numberOrNull(raw.completion_tokens),
    totalTokens: numberOrNull(raw.total_tokens),
  };
  return traced.promptTokens === null &&
    traced.completionTokens === null &&
    traced.totalTokens === null
    ? null
    : traced;
}

/** finish_reason は決まった短い値だけを残す。想定外の値は "other" にする。 */
export function traceFinishReason(finishReason: unknown): string | null {
  if (finishReason === undefined || finishReason === null) return null;
  return typeof finishReason === "string" && KNOWN_FINISH_REASONS.has(finishReason)
    ? finishReason
    : "other";
}

const KNOWN_FINISH_REASONS = new Set([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "function_call",
]);

/** 例外から、記録してよい種類と HTTP ステータスだけを取り出す。 */
export function traceError(
  error: unknown,
  emptyAnswer: boolean
): {
  errorKind: AgentRunErrorKind;
  httpStatus?: number;
} {
  if (error instanceof ApiRequestError && error.kind !== "cancelled") {
    return {
      errorKind: error.kind,
      ...(error.status === undefined ? {} : { httpStatus: error.status }),
    };
  }
  return { errorKind: emptyAnswer ? "empty-answer" : "other" };
}

/** これまでの console.log と同じ行を出す sink。 */
export const consoleTraceSink: AgentTraceSink = (event) => {
  switch (event.type) {
    case "llm_start":
      console.log(
        `[Agent] iteration ${event.iteration}/${event.maxIterations}, messages=${event.messageCount}, payload~${event.payloadChars} chars, forceFinal=${event.forcedFinal}`
      );
      break;
    case "tool_start":
      console.log(`[Agent] tool: ${event.tool}`);
      break;
    case "run_end":
      console.log(
        `[Agent] run end: ${event.reason}, ${event.durationMs} ms, iterations=${event.iterations}, tools=${event.toolCalls}${event.exceededBudget ? `, budget=${event.exceededBudget}` : ""}`
      );
      break;
    default:
      break;
  }
};
