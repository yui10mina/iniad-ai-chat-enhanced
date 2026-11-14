import type { ChatProgress, ChatProgressTool } from "../shared/types/chat";

const TOOL_LABELS: Readonly<Record<ChatProgressTool, string>> = {
  login: "MOOCs にログインしています",
  list_courses: "コースの一覧を確認しています",
  navigate: "MOOCs のページを開いています",
  list_lectures: "講義の一覧を確認しています",
  list_slides: "資料の一覧を確認しています",
  read_slide: "資料を読んでいます",
  expand_slide_tab: "スライドを表示しています",
  page_content: "ページの内容を読んでいます",
  google_login: "Google にログインしています",
  web_search: "Web を検索しています",
  other: "調べています",
};

/**
 * 回答の生成中に出す状態の文。まだ進捗が届いていないときは準備中とする。
 * 調査の回数は「何回目か」だけを見せ、上限は見せない（上限まで使うとは限らないため）。
 */
export function chatProgressLabel(progress: ChatProgress | null | undefined): string {
  if (!progress) return "準備しています…";
  if (progress.kind === "tool") {
    return `${TOOL_LABELS[progress.tool] ?? TOOL_LABELS.other}…（調査 ${progress.sequence} 件目）`;
  }
  if (progress.final) return "集めた情報から回答をまとめています…";
  return progress.iteration <= 1 ? "質問を読んでいます…" : "次に調べることを考えています…";
}
