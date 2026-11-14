/**
 * 回答の生成中に画面へ出す進捗のテスト。
 * 記録（trace）から取り出す内容に URL、引数、本文が入らないこと、
 * 送り先が 1 つのウィンドウに限られること、画面の文を確かめる。
 */
import { describe, expect, it, vi } from "vitest";
import {
  CHAT_PROGRESS_CHANNEL,
  createProgressSink,
  toChatProgress,
} from "../../src/main/chat-progress";
import type { AgentTraceEvent } from "../../src/main/services/agent-trace";
import { MOOCS_AGENT_TOOLS } from "../../src/main/services/moocs-tool-definitions";
import { chatProgressLabel } from "../../src/renderer/chat-progress-label";
import type { ChatProgress } from "../../src/shared/types/chat";

const SECRET = "SECRET";

const llmStart: AgentTraceEvent = {
  type: "llm_start",
  at: 1,
  iteration: 3,
  maxIterations: 10,
  messageCount: 7,
  payloadChars: 4_321,
  toolsOffered: true,
  webSearchOffered: false,
  forcedFinal: false,
};

function toolStart(tool: string): AgentTraceEvent {
  return {
    type: "tool_start",
    at: 2,
    iteration: 3,
    sequence: 4,
    tool,
    args: { argsChars: 60, urlPath: `/courses/2026/${SECRET}/1`, queryChars: 12 },
  };
}

const otherEvents: AgentTraceEvent[] = [
  { type: "run_start", at: 0, historyTurns: 2, priorMaterials: 1, hasSyllabusHint: true },
  {
    type: "llm_end",
    at: 3,
    iteration: 3,
    durationMs: 900,
    finishReason: "stop",
    usage: null,
    toolCalls: 0,
    toolCallsDiscarded: false,
    contentChars: 120,
  },
  {
    type: "tool_end",
    at: 4,
    iteration: 3,
    sequence: 4,
    tool: "moocs_read_slide",
    durationMs: 1_200,
    outcome: { ok: true, code: "ok" },
    resultChars: 3_000,
    citations: 1,
    materials: 1,
  },
  {
    type: "run_end",
    at: 5,
    durationMs: 5_000,
    reason: "answered",
    iterations: 4,
    toolCalls: 4,
    answerChars: 300,
    citations: 2,
  },
];

describe("toChatProgress", () => {
  it("turns llm_start into a thinking step with exactly four fields", () => {
    expect(toChatProgress(llmStart)).toEqual({
      kind: "thinking",
      iteration: 3,
      maxIterations: 10,
      final: false,
    });
  });

  it("marks the forced final answer", () => {
    expect(toChatProgress({ ...llmStart, forcedFinal: true })).toMatchObject({ final: true });
  });

  it("turns tool_start into a tool step without its arguments", () => {
    const progress = toChatProgress(toolStart("moocs_read_slide"));

    expect(progress).toEqual({ kind: "tool", iteration: 3, sequence: 4, tool: "read_slide" });
    expect(JSON.stringify(progress)).not.toContain(SECRET);
    expect(JSON.stringify(progress)).not.toContain("/courses");
  });

  it("has a label for every tool the agent offers", () => {
    for (const { function: tool } of MOOCS_AGENT_TOOLS) {
      const progress = toChatProgress(toolStart(tool.name));

      expect(progress, tool.name).toMatchObject({ kind: "tool" });
      expect((progress as { tool: string }).tool, tool.name).not.toBe("other");
    }
  });

  it.each(["unknown", "toString", "__proto__", "constructor"])(
    "shows a tool name it has no label for (%s) as other",
    (tool) => {
      expect(toChatProgress(toolStart(tool))).toMatchObject({ tool: "other" });
    }
  );

  it("does not report the events that only describe what already finished", () => {
    for (const event of otherEvents) {
      expect(toChatProgress(event), event.type).toBeNull();
    }
  });
});

describe("createProgressSink", () => {
  function target(destroyed = false) {
    return { isDestroyed: vi.fn().mockReturnValue(destroyed), send: vi.fn() };
  }

  it("sends progress on the chat:progress channel to its own target only", () => {
    const sender = target();
    const otherWindow = target();
    const sink = createProgressSink(sender);
    createProgressSink(otherWindow);

    sink(llmStart);
    sink(toolStart("moocs_navigate"));

    expect(CHAT_PROGRESS_CHANNEL).toBe("chat:progress");
    expect(sender.send.mock.calls).toEqual([
      ["chat:progress", { kind: "thinking", iteration: 3, maxIterations: 10, final: false }],
      ["chat:progress", { kind: "tool", iteration: 3, sequence: 4, tool: "navigate" }],
    ]);
    expect(otherWindow.send).not.toHaveBeenCalled();
  });

  it("sends nothing for events that are not progress", () => {
    const sender = target();
    const sink = createProgressSink(sender);

    for (const event of otherEvents) sink(event);

    expect(sender.send).not.toHaveBeenCalled();
  });

  it("stops sending once the window is destroyed", () => {
    const sender = target();
    const sink = createProgressSink(sender);

    sink(llmStart);
    sender.isDestroyed.mockReturnValue(true);
    sink(toolStart("moocs_navigate"));

    expect(sender.send).toHaveBeenCalledTimes(1);
  });
});

describe("chatProgressLabel", () => {
  const thinking = (iteration: number, final = false): ChatProgress => ({
    kind: "thinking",
    iteration,
    maxIterations: 10,
    final,
  });

  it("says it is preparing before any progress arrives", () => {
    expect(chatProgressLabel(null)).toBe("準備しています…");
    expect(chatProgressLabel(undefined)).toBe("準備しています…");
  });

  it("tells reading the question from planning the next step and from writing the answer", () => {
    expect(chatProgressLabel(thinking(1))).toBe("質問を読んでいます…");
    expect(chatProgressLabel(thinking(2))).toBe("次に調べることを考えています…");
    expect(chatProgressLabel(thinking(9, true))).toBe("集めた情報から回答をまとめています…");
  });

  it("names what a tool step does and which call it is", () => {
    expect(chatProgressLabel({ kind: "tool", iteration: 2, sequence: 3, tool: "read_slide" })).toBe(
      "資料を読んでいます…（調査 3 件目）"
    );
    expect(chatProgressLabel({ kind: "tool", iteration: 1, sequence: 1, tool: "other" })).toBe(
      "調べています…（調査 1 件目）"
    );
  });

  it("falls back to a general label for a tool kind it does not know", () => {
    const progress = { kind: "tool", iteration: 1, sequence: 2, tool: "new_tool" } as unknown;

    expect(chatProgressLabel(progress as ChatProgress)).toBe("調べています…（調査 2 件目）");
  });

  it("has a distinct label for every tool kind", () => {
    const labels = MOOCS_AGENT_TOOLS.map(({ function: tool }) =>
      chatProgressLabel(toChatProgress(toolStart(tool.name)))
    );

    expect(new Set(labels).size).toBe(MOOCS_AGENT_TOOLS.length);
  });
});
