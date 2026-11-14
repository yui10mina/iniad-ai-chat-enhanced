/**
 * チャット関連の共通型定義
 * Main ↔ Renderer 間で共有されるチャットデータの型
 */

/**
 * 回答が最後まで書かれずに終わった理由。
 * truncated: 出力の上限で切れた（finish_reason=length）
 * filtered: コンテンツフィルタで止められた（finish_reason=content_filter）
 */
export type AnswerCompletion = "truncated" | "filtered";

/** 会話の1ターン（ユーザーまたはAIの発言） */
export interface ChatTurn {
  /** 一意なメッセージID */
  id: string;
  /** "user" | "assistant" */
  role: "user" | "assistant";
  /** メッセージ本文 */
  content: string;
  /** AI回答の場合、参照元の引用情報 */
  citations?: Citation[];
  /** AI回答が最後まで書かれずに終わった理由。最後まで書かれた回答では付かない。 */
  completion?: AnswerCompletion;
  /** タイムスタンプ（ISO 8601 文字列） */
  timestamp: string;
}

/** 参照元（RAGで取得した資料の引用情報） */
export interface Citation {
  /** 資料のタイトル */
  title: string;
  /** 資料のURL */
  url: string;
  /** 関連部分のスニペット */
  snippet?: string;
  /** 資料内の位置（例: 第1回 / スライド1） */
  location?: string;
  /** 出典種別 */
  sourceType?: "moocs" | "web";
}

/** Renderer に公開する資料コンテキストの概要（本文は Main 内だけで保持） */
export interface MaterialContextSummary {
  id: string;
  title: string;
  url: string;
  location?: string;
  lastReferencedAt: string;
}

/** chat:send のレスポンス */
export interface ChatResponse {
  /** AIの回答テキスト */
  content: string;
  /** 参照元の一覧 */
  citations: Citation[];
  /** レスポンスのレイテンシ（ミリ秒） */
  latencyMs?: number;
  /** 回答が最後まで書かれずに終わった理由。最後まで書かれた回答では付かない。 */
  completion?: AnswerCompletion;
}

/** OpenAI 互換のツール定義 */
export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** ツール呼び出し（assistant メッセージ内） */
export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** エージェントループ用メッセージ */
export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** Chat Completions API のレスポンス（INIAD API / OpenAI 互換） */
export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ChatToolCall[];
    };
    /** OpenAI 互換の実装によっては付かないことがある */
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
