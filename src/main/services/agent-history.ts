/** API に送る会話履歴を、件数と文字数の上限に収まるように選ぶ。 */
import type { AgentMessage, ChatTurn } from "../../shared/types/chat";

const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_CHARS = 2_000;
const RECENT_HISTORY_TURNS_FOR_EXPLICIT_REFERENCE = 2;

const PRIOR_CONVERSATION_PATTERN =
  /(?:以前|前回|前に|先ほど|さっき|これまで|過去).{0,16}(?:会話|やり取り|質問|回答|説明)/;
const HISTORY_QUERY_NOISE_PATTERN =
  /(?:以前|前回|前に|先ほど|さっき|これまで|過去|会話|やり取り|質問|回答|説明|踏まえて|基づいて|参照して|もう一度|教えて|ください|です|ます)/g;
const HISTORY_QUERY_SPLIT_PATTERN =
  /[\s\u3000、。！？・,.;:：；()（）「」『』【】[\]のはがをにでともへやからまで]+/;

export function buildHistoryMessages(
  history: ChatTurn[] | undefined,
  userText: string
): AgentMessage[] {
  if (!history?.length) return [];

  const last = history[history.length - 1];
  const hasDup = last.role === "user" && last.content === userText;
  const availableHistory = hasDup ? history.slice(0, -1) : history.slice();

  const selectedHistory = PRIOR_CONVERSATION_PATTERN.test(userText.normalize("NFKC"))
    ? selectHistoryForExplicitReference(availableHistory, userText)
    : availableHistory.slice(-MAX_HISTORY_TURNS);

  let remainingHistoryChars = MAX_HISTORY_CHARS;
  const selected: ChatTurn[] = [];
  for (let i = selectedHistory.length - 1; i >= 0; i--) {
    if (remainingHistoryChars <= 0) break;
    const turn = selectedHistory[i];
    const content = truncateHistoryTurn(turn.content, remainingHistoryChars);
    if (!content) continue;
    selected.unshift({ ...turn, content });
    remainingHistoryChars -= content.length;
  }

  return selected.map((turn) => ({
    role: turn.role,
    content: turn.content,
  }));
}

function selectHistoryForExplicitReference(history: ChatTurn[], userText: string): ChatTurn[] {
  if (history.length <= MAX_HISTORY_TURNS) return history;
  const tokens = tokenizeHistoryQuery(userText);
  const recentStart = Math.max(0, history.length - RECENT_HISTORY_TURNS_FOR_EXPLICIT_REFERENCE);
  const ranked = history
    .map((turn, index) => ({
      turn,
      index,
      score: scoreHistoryTurn(turn, tokens) + (index >= recentStart ? 0.2 : 0),
    }))
    .filter(({ score, index }) => score > 0 || index >= recentStart)
    .sort((a, b) => b.score - a.score || b.index - a.index);

  const chosen = new Map<number, ChatTurn>();
  let chars = 0;
  for (const candidate of ranked) {
    if (chosen.size >= MAX_HISTORY_TURNS) break;
    const candidateIndices = adjacentConversationIndices(history, candidate.index).filter(
      (index) => !chosen.has(index) && history[index].content.length > 0
    );
    if (
      candidateIndices.length === 0 ||
      chosen.size + candidateIndices.length > MAX_HISTORY_TURNS
    ) {
      continue;
    }

    const boundedGroup = boundHistoryGroup(
      candidateIndices.map((index) => ({ index, turn: history[index] })),
      MAX_HISTORY_CHARS - chars
    );
    if (boundedGroup.length === 0) continue;
    for (const { index, turn } of boundedGroup) chosen.set(index, turn);
    chars += boundedGroup.reduce((sum, { turn }) => sum + turn.content.length, 0);
  }

  if (chosen.size === 0) return history.slice(-MAX_HISTORY_TURNS);
  return [...chosen.entries()].sort(([left], [right]) => left - right).map(([, turn]) => turn);
}

function tokenizeHistoryQuery(query: string): string[] {
  const normalized = query
    .normalize("NFKC")
    .toLowerCase()
    .replace(HISTORY_QUERY_NOISE_PATTERN, " ");
  return [
    ...new Set(normalized.split(HISTORY_QUERY_SPLIT_PATTERN).map((token) => token.trim())),
  ].filter((token) => token.length >= 2);
}

function scoreHistoryTurn(turn: ChatTurn, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const content = turn.content.normalize("NFKC").toLowerCase();
  return (
    tokens.reduce((score, token) => score + (content.includes(token) ? 1 : 0), 0) / tokens.length
  );
}

function truncateHistoryTurn(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const marker = "\n…[中略]…\n";
  if (maxChars <= marker.length) return content.slice(-maxChars);
  const available = maxChars - marker.length;
  const headChars = Math.floor(available / 2);
  const tailChars = available - headChars;
  return `${content.slice(0, headChars)}${marker}${content.slice(-tailChars)}`;
}

function adjacentConversationIndices(history: ChatTurn[], index: number): number[] {
  const turn = history[index];
  if (turn.role === "user" && history[index + 1]?.role === "assistant") {
    return [index, index + 1];
  }
  if (turn.role === "assistant" && history[index - 1]?.role === "user") {
    return [index - 1, index];
  }
  return [index];
}

function boundHistoryGroup(
  entries: Array<{ index: number; turn: ChatTurn }>,
  maxChars: number
): Array<{ index: number; turn: ChatTurn }> {
  if (maxChars < entries.length) return [];

  let remainingChars = maxChars;
  const bounded: Array<{ index: number; turn: ChatTurn }> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const remainingTurns = entries.length - i;
    const turnBudget =
      remainingTurns === 1
        ? remainingChars
        : Math.max(1, Math.floor(remainingChars / remainingTurns));
    const content = truncateHistoryTurn(entry.turn.content, turnBudget);
    if (!content) continue;
    bounded.push({ index: entry.index, turn: { ...entry.turn, content } });
    remainingChars -= content.length;
  }
  return bounded;
}
