import { describe, expect, it } from "vitest";
import { completionNoticeText } from "../../src/renderer/completion-notice";

describe("completionNoticeText", () => {
  it("returns no notice for a complete answer", () => {
    expect(completionNoticeText(undefined)).toBeNull();
  });

  it("tells the user that a truncated answer stops partway", () => {
    expect(completionNoticeText("truncated")).toBe(
      "回答が出力の上限で途中までになっています。続きが必要なら、質問を分けて送ってください。"
    );
  });

  it("tells the user that a filtered answer was stopped by the content filter", () => {
    expect(completionNoticeText("filtered")).toBe(
      "回答がコンテンツフィルタで途中で止められました。表示されている部分だけが返っています。"
    );
  });
});
