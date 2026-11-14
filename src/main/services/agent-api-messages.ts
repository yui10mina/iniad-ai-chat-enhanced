import type { AgentMessage } from "../../shared/types/chat";
import { wrapUntrustedReference } from "./untrusted-reference";

/**
 * API に送るツール結果の本文の合計の上限（文字数）。
 * 以前は直近 2 件だけを残していたので、資料を 3 枚読むと 1 枚目の本文を失っていた。
 * 値は実測から決めた: スライド 1 枚は約 2,300 字、ツール結果 1 件の上限は 4,000 字で、
 * 12,000 字ならスライド 5 枚、または上限いっぱいの結果 3 件が入る。
 */
export const TOOL_RESULT_CHAR_BUDGET = 12_000;

/**
 * 直近 2 件より前の、資料の本文ではない結果（コース一覧、講義一覧、ページ移動など）に使える上限。
 * 全体の予算の内数。実測では、最初のログインが返すコース一覧（4,000 字）が最後まで残り、
 * 毎回の送信量を押し上げていた。一覧は取り直しが安く、次の一手を決めたあとは価値が下がるので、
 * 本文より小さい枠にする。2,500 字なら、講義一覧 1 件（約 2,000 字）とページ移動の結果が入る。
 */
export const OLDER_LISTING_CHAR_BUDGET = 2_500;

/** 予算に関係なく本文を残す、直近のツール結果の数。次の一手に必要な一覧などを落とさないため。 */
const KEEP_RECENT_TOOL_RESULTS = 2;

const OMITTED_TOOL_BODY = "[以前のツール結果は省略。直近の調査結果を参照してください。]";
const OMITTED_MATERIAL_NOTE =
  "[この資料の本文は省略しました。必要なら同じ URL をもう一度読んでください。]";
const MAX_STUB_TITLE_CHARS = 200;
const MAX_STUB_URL_CHARS = 300;
const MAX_STUB_SOURCES = 3;

/** ツール結果 1 件について、本文を残すか決めるための情報。 */
export interface ToolResultMeta {
  /** 資料の本文を含む結果か（一覧やページ移動の結果ではなく） */
  hasBody: boolean;
  /** 本文を省略するときに残す、資料の題名と URL */
  sources: ReadonlyArray<{ title: string; url: string }>;
}

/** メッセージそのものをキーにする。tool_call_id はモデルが決める値なので、重複し得る。 */
export type ToolResultMetaMap = WeakMap<AgentMessage, ToolResultMeta>;

/**
 * OpenAI 互換 API 用にメッセージ列を整える。
 * ツール結果の本文を文字数の予算に収め、入らない分は本文だけを差し替える
 * （assistant の tool_calls と tool メッセージの対応は必ず残す）。
 *
 * 残す順:
 *   1. 直近 2 件（種類を問わない）
 *   2. それより前の、資料の本文を含む結果（新しい順）
 *   3. それより前の、その他の結果（新しい順。全体の予算の内数で、別の小さな上限まで）
 * 資料の本文を省略するときは、題名と URL を境界の中に残す。要約はしない
 * （信頼できない内容を、境界の外で書き直すことになるため）。
 */
export function prepareApiMessages(
  messages: AgentMessage[],
  toolResultMeta?: ToolResultMetaMap,
  budgetChars: number = TOOL_RESULT_CHAR_BUDGET,
  olderListingBudgetChars: number = OLDER_LISTING_CHAR_BUDGET
): AgentMessage[] {
  const toolIndices = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  if (toolIndices.length <= KEEP_RECENT_TOOL_RESULTS) return messages;

  const lengthOf = (index: number): number => {
    const message = messages[index];
    return message.role === "tool" ? message.content.length : 0;
  };
  const hasBody = (index: number): boolean =>
    toolResultMeta?.get(messages[index])?.hasBody === true;

  const recent = toolIndices.slice(-KEEP_RECENT_TOOL_RESULTS);
  const older = toolIndices.slice(0, -KEEP_RECENT_TOOL_RESULTS).reverse();
  const kept = new Set<number>(recent);
  let used = recent.reduce((sum, index) => sum + lengthOf(index), 0);

  let usedByListings = 0;
  for (const index of [...older.filter(hasBody), ...older.filter((i) => !hasBody(i))]) {
    const length = lengthOf(index);
    if (used + length > budgetChars) continue;
    if (!hasBody(index)) {
      if (usedByListings + length > olderListingBudgetChars) continue;
      usedByListings += length;
    }
    kept.add(index);
    used += length;
  }
  if (kept.size === toolIndices.length) return messages;

  return messages.map((message, index) => {
    if (message.role !== "tool" || kept.has(index)) return message;
    return { ...message, content: omittedContent(toolResultMeta?.get(message)) };
  });
}

function omittedContent(meta: ToolResultMeta | undefined): string {
  if (!meta?.hasBody || meta.sources.length === 0) return OMITTED_TOOL_BODY;
  const lines = [OMITTED_MATERIAL_NOTE];
  for (const source of meta.sources.slice(0, MAX_STUB_SOURCES)) {
    lines.push(`Title: ${source.title.slice(0, MAX_STUB_TITLE_CHARS)}`);
    // 途中で切れた URL は使えないので、長すぎるものは載せない。
    if (source.url.length <= MAX_STUB_URL_CHARS) lines.push(`URL: ${source.url}`);
  }
  // 題名と URL もページ由来なので、本文と同じ境界で包む。
  return wrapUntrustedReference(lines.join("\n"), "OMITTED_TOOL_RESULT");
}

export function estimatePayloadChars(messages: AgentMessage[]): number {
  return JSON.stringify(messages).length;
}
