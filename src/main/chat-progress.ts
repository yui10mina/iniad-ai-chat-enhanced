/**
 * 実行の記録（trace）から、画面に出す進捗だけを取り出して Renderer へ送る。
 * 送るのは「何をしているか」の種類と番号だけで、URL、引数、本文は含めない。
 */
import type { ChatProgress, ChatProgressTool } from "../shared/types/chat";
import type { AgentTraceEvent, AgentTraceSink } from "./services/agent-trace";

export const CHAT_PROGRESS_CHANNEL = "chat:progress";

const PROGRESS_TOOLS: Readonly<Record<string, ChatProgressTool>> = {
  moocs_login: "login",
  moocs_list_courses: "list_courses",
  moocs_navigate: "navigate",
  moocs_list_lectures: "list_lectures",
  moocs_list_slides: "list_slides",
  moocs_read_slide: "read_slide",
  moocs_expand_slide_tab: "expand_slide_tab",
  moocs_page_content: "page_content",
  moocs_google_login: "google_login",
  web_search: "web_search",
};

/**
 * 進捗として見せるイベントだけを変換する。待ち始めたこと（llm_start、tool_start）を
 * 伝えるのが目的なので、終了のイベントは送らない。
 * 必要な項目だけを 1 つずつ写し、イベントをそのまま渡さない。
 */
export function toChatProgress(event: AgentTraceEvent): ChatProgress | null {
  switch (event.type) {
    case "llm_start":
      return {
        kind: "thinking",
        iteration: event.iteration,
        maxIterations: event.maxIterations,
        final: event.forcedFinal,
      };
    case "tool_start":
      return {
        kind: "tool",
        iteration: event.iteration,
        sequence: event.sequence,
        tool: Object.hasOwn(PROGRESS_TOOLS, event.tool) ? PROGRESS_TOOLS[event.tool] : "other",
      };
    default:
      return null;
  }
}

/** 進捗の送り先。Electron の WebContents のうち、使う部分だけ。 */
export interface ChatProgressTarget {
  isDestroyed(): boolean;
  send(channel: string, progress: ChatProgress): void;
}

/**
 * 質問を送ってきたウィンドウだけへ進捗を送る sink。mcp:status のように全ウィンドウへは
 * 配らない。ウィンドウが閉じられたあとは送らない。
 */
export function createProgressSink(target: ChatProgressTarget): AgentTraceSink {
  return (event) => {
    const progress = toChatProgress(event);
    if (!progress || target.isDestroyed()) return;
    target.send(CHAT_PROGRESS_CHANNEL, progress);
  };
}
