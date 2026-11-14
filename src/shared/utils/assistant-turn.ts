import type { ChatResponse, ChatTurn } from "../types/chat";

/**
 * 回答を、履歴と画面に載せるターンへ変換する。
 * 途中で終わった回答の印は、あとから見ても分かるようにターンへ残す。
 * 最後まで書かれた回答には completion を付けない。
 */
export function toAssistantTurn(response: ChatResponse, id: string, timestamp: string): ChatTurn {
  return {
    id,
    role: "assistant",
    content: response.content,
    citations: response.citations,
    ...(response.completion ? { completion: response.completion } : {}),
    timestamp,
  };
}
