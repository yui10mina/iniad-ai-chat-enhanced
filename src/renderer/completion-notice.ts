import type { ChatResponse } from "../shared/types/chat";

/**
 * 回答が最後まで書かれなかったときに出す通知の文。最後まで書かれた回答では null。
 * 回答本文には手を加えず、通知だけで知らせる。
 */
/**
 * 途中で終わった回答のメッセージに付ける短い印。最後まで書かれた回答では null。
 * 通知は次の送信で消えるので、どの回答が途中までかはこの印で残す。
 */
export function completionLabel(completion: ChatResponse["completion"]): string | null {
  switch (completion) {
    case "truncated":
      return "出力の上限に達したため、この回答は途中までです";
    case "filtered":
      return "コンテンツフィルタで止められたため、この回答は途中までです";
    default:
      return null;
  }
}

export function completionNoticeText(completion: ChatResponse["completion"]): string | null {
  switch (completion) {
    case "truncated":
      return "回答が出力の上限で途中までになっています。続きが必要なら、質問を分けて送ってください。";
    case "filtered":
      return "回答がコンテンツフィルタで途中で止められました。表示されている部分だけが返っています。";
    default:
      return null;
  }
}
