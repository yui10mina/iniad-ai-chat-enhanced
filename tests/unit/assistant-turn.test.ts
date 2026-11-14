import { describe, expect, it } from "vitest";
import { toAssistantTurn } from "../../src/shared/utils/assistant-turn";
import type { Citation } from "../../src/shared/types/chat";

const citations: Citation[] = [
  { title: "第1回", url: "https://moocs.iniad.org/courses/2026/TEST/1", sourceType: "moocs" },
];

describe("toAssistantTurn", () => {
  it("keeps a complete answer free of a completion field", () => {
    const turn = toAssistantTurn(
      { content: "回答です。", citations, latencyMs: 120 },
      "msg_1_ai",
      "2026-11-14T00:00:00.000Z"
    );

    expect(turn).toEqual({
      id: "msg_1_ai",
      role: "assistant",
      content: "回答です。",
      citations,
      timestamp: "2026-11-14T00:00:00.000Z",
    });
    expect(Object.keys(turn)).not.toContain("completion");
  });

  it.each(["truncated", "filtered"] as const)(
    "carries the %s mark into the turn without changing the text",
    (completion) => {
      const turn = toAssistantTurn(
        { content: "途中で終わった回答", citations: [], completion },
        "msg_2_ai",
        "2026-11-14T00:00:00.000Z"
      );

      expect(turn.completion).toBe(completion);
      expect(turn.content).toBe("途中で終わった回答");
    }
  );

  it("does not copy response-only fields such as latencyMs", () => {
    const turn = toAssistantTurn(
      { content: "回答です。", citations: [], latencyMs: 120 },
      "msg_3_ai",
      "2026-11-14T00:00:00.000Z"
    );

    expect(Object.keys(turn).sort()).toEqual(["citations", "content", "id", "role", "timestamp"]);
  });
});
