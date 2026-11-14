import { describe, expect, it } from "vitest";
import { completionLabel, completionNoticeText } from "../../src/renderer/completion-notice";

describe("completionLabel", () => {
  it("returns no label for a complete answer", () => {
    expect(completionLabel(undefined)).toBeNull();
  });

  it("labels a truncated answer", () => {
    expect(completionLabel("truncated")).toBe("出力の上限に達したため、この回答は途中までです");
  });

  it("labels a filtered answer", () => {
    expect(completionLabel("filtered")).toBe(
      "コンテンツフィルタで止められたため、この回答は途中までです"
    );
  });
});

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
