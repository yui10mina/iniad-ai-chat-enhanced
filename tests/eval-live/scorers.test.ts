/**
 * live 評価の採点関数のテスト。採点はネットワークを使わないので、CI でも動く。
 */
import { describe, expect, it } from "vitest";
import type { AgentTraceEvent } from "../../src/main/services/agent-trace";
import {
  measureRun,
  normalizeText,
  parseQuestions,
  scoreRun,
  spreadOf,
  summarizeQuestion,
  urlPathOf,
  type LiveQuestion,
  type LiveRunRecord,
  type LiveScore,
} from "./scorers";

const SLIDE_1 = "https://moocs.iniad.org/courses/2099/TEST101/01/01";
const SLIDE_2 = "https://moocs.iniad.org/courses/2099/TEST101/01/02";

function llmEnd(usage: { promptTokens: number; completionTokens: number } | null): AgentTraceEvent {
  return {
    type: "llm_end",
    at: 0,
    iteration: 1,
    durationMs: 100,
    finishReason: "stop",
    usage: usage ? { ...usage, totalTokens: usage.promptTokens + usage.completionTokens } : null,
    toolCalls: 0,
    toolCallsDiscarded: false,
    contentChars: 0,
  };
}

function tool(
  sequence: number,
  name: string,
  urlPath: string | null,
  ok = true
): AgentTraceEvent[] {
  return [
    {
      type: "tool_start",
      at: 0,
      iteration: 1,
      sequence,
      tool: name,
      args: { argsChars: 10, ...(urlPath ? { urlPath } : {}) },
    },
    {
      type: "tool_end",
      at: 0,
      iteration: 1,
      sequence,
      tool: name,
      durationMs: 50,
      outcome: ok ? { ok: true, code: "ok" } : { ok: false, code: "exception" },
      resultChars: 100,
      citations: 0,
      materials: 0,
    },
  ];
}

function runEnd(reason: "answered" | "error" | "answer_incomplete" = "answered"): AgentTraceEvent {
  return {
    type: "run_end",
    at: 0,
    durationMs: 4_000,
    reason,
    iterations: 3,
    toolCalls: 2,
    answerChars: 20,
    citations: 1,
  };
}

function record(overrides: Partial<LiveRunRecord> = {}): LiveRunRecord {
  return {
    questionId: "q1",
    attempt: 1,
    answer: "ＴＣＰ は接続を確立してから データを送ります。",
    citations: [SLIDE_1],
    events: [
      ...tool(1, "moocs_login", null),
      llmEnd({ promptTokens: 1_000, completionTokens: 10 }),
      ...tool(2, "moocs_read_slide", "/courses/2099/TEST101/01/01"),
      llmEnd({ promptTokens: 1_500, completionTokens: 40 }),
      runEnd(),
    ],
    ...overrides,
  };
}

const question: LiveQuestion = {
  id: "q1",
  question: "TCP とは",
  expect: {
    tools: ["moocs_read_slide"],
    urlPaths: ["/courses/2099/TEST101/01/01"],
    phrases: ["tcp", "接続を確立"],
  },
};

describe("normalizeText and urlPathOf", () => {
  it("ignores width, case and whitespace", () => {
    expect(normalizeText("ＴＣＰ　は  Ｓｙｎ\nを送る")).toBe("tcpはsynを送る");
  });

  it("takes the path of a URL without the trailing slash, query or fragment", () => {
    expect(urlPathOf(`${SLIDE_1}/?a=1#top`)).toBe("/courses/2099/TEST101/01/01");
    expect(urlPathOf("https://moocs.iniad.org/")).toBe("/");
    expect(urlPathOf("not a url")).toBeNull();
  });
});

describe("scoreRun", () => {
  it("gives full marks when every expectation is met", () => {
    const score = scoreRun(question, record());

    expect(score).toMatchObject({
      questionId: "q1",
      attempt: 1,
      tools: 1,
      urlPaths: 1,
      phrases: 1,
    });
    expect(score.missing).toEqual({ tools: [], urlPaths: [], phrases: [] });
  });

  it("gives the met fraction and lists what is missing", () => {
    const score = scoreRun(
      {
        ...question,
        expect: {
          tools: ["moocs_read_slide", "moocs_list_slides"],
          urlPaths: ["/courses/2099/TEST101/01/01", "/courses/2099/TEST101/01/02"],
          phrases: ["tcp", "接続を確立", "輻輳制御", "再送"],
        },
      },
      record()
    );

    expect(score.tools).toBe(0.5);
    expect(score.urlPaths).toBe(0.5);
    expect(score.phrases).toBe(0.5);
    expect(score.missing).toEqual({
      tools: ["moocs_list_slides"],
      urlPaths: ["/courses/2099/TEST101/01/02"],
      phrases: ["輻輳制御", "再送"],
    });
  });

  it("does not count a tool that was called but failed", () => {
    const failed = record({
      events: [...tool(1, "moocs_read_slide", "/courses/2099/TEST101/01/01", false), runEnd()],
    });

    expect(scoreRun(question, failed).tools).toBe(0);
  });

  it("counts a URL only when it is cited, not when it was merely read", () => {
    expect(scoreRun(question, record({ citations: [] })).urlPaths).toBe(0);
    expect(scoreRun(question, record({ citations: [SLIDE_2] })).urlPaths).toBe(0);
    expect(scoreRun(question, record({ citations: [`${SLIDE_1}/`] })).urlPaths).toBe(1);
  });

  it("scores a failed run as zero on what it expected, not as null", () => {
    const failed = record({ answer: "", citations: [], error: "boom", events: [runEnd("error")] });

    expect(scoreRun(question, failed)).toMatchObject({ tools: 0, urlPaths: 0, phrases: 0 });
  });

  it.each<{ name: string; expectValue: LiveQuestion["expect"] }>([
    { name: "no expect at all", expectValue: undefined },
    { name: "an empty expect", expectValue: {} },
    { name: "empty lists", expectValue: { tools: [], urlPaths: [], phrases: [] } },
  ])("leaves the scores null with $name but still measures the run", ({ expectValue }) => {
    const score = scoreRun({ id: "q1", question: "TCP とは", expect: expectValue }, record());

    expect(score).toMatchObject({ tools: null, urlPaths: null, phrases: null });
    expect(score.metrics.outcome).toBe("answered");
  });
});

describe("measureRun", () => {
  it("reads the outcome, time and counts from run_end and sums the usage", () => {
    expect(measureRun(record())).toEqual({
      outcome: "answered",
      durationMs: 4_000,
      iterations: 3,
      toolCalls: 2,
      failedToolCalls: 0,
      repeatedReads: 0,
      promptTokens: 2_500,
      completionTokens: 50,
      answerChars: record().answer.length,
      citations: 1,
    });
  });

  it("counts every read of a URL after the first as a repeat", () => {
    const events = [
      ...tool(1, "moocs_read_slide", "/a"),
      ...tool(2, "moocs_read_slide", "/b"),
      ...tool(3, "moocs_read_slide", "/b"),
      ...tool(4, "moocs_read_slide", "/a"),
      ...tool(5, "moocs_read_slide", "/a"),
      // 同じページを開き直すだけなら、読み直しには数えない。
      ...tool(6, "moocs_navigate", "/a"),
      runEnd(),
    ];

    expect(measureRun(record({ events })).repeatedReads).toBe(3);
  });

  it("counts failed and refused tool calls", () => {
    const events = [
      ...tool(1, "moocs_read_slide", "/a", false),
      ...tool(2, "moocs_read_slide", "/a"),
      runEnd(),
    ];

    expect(measureRun(record({ events })).failedToolCalls).toBe(1);
  });

  it("reports the token totals as null when any call came without usage", () => {
    const events = [llmEnd({ promptTokens: 1_000, completionTokens: 10 }), llmEnd(null), runEnd()];

    expect(measureRun(record({ events }))).toMatchObject({
      promptTokens: null,
      completionTokens: null,
    });
  });

  it("reports the token totals as null, not zero, when the model was never called", () => {
    const failedBeforeAnyCall = record({ answer: "", citations: [], events: [runEnd("error")] });

    expect(measureRun(failedBeforeAnyCall)).toMatchObject({
      promptTokens: null,
      completionTokens: null,
    });
  });

  it("still measures a run whose trace has no run_end", () => {
    const events = [llmEnd(null), ...tool(1, "moocs_login", null)];

    expect(measureRun(record({ events }))).toMatchObject({
      outcome: "no_run_end",
      durationMs: null,
      iterations: 1,
      toolCalls: 1,
      promptTokens: null,
    });
  });
});

describe("spreadOf and summarizeQuestion", () => {
  it("gives the mean, min and max of the values that are present", () => {
    expect(spreadOf([1, null, 0.5, 0])).toEqual({ n: 3, mean: 0.5, min: 0, max: 1 });
    expect(spreadOf([null, null])).toBeNull();
    expect(spreadOf([])).toBeNull();
  });

  it("summarizes the runs of one question and ignores the other questions", () => {
    const base = scoreRun(question, record());
    const scores: LiveScore[] = [
      base,
      { ...base, attempt: 2, phrases: 0.5, metrics: { ...base.metrics, durationMs: 6_000 } },
      {
        ...base,
        attempt: 3,
        phrases: 0,
        metrics: { ...base.metrics, outcome: "error", durationMs: null, promptTokens: null },
      },
      { ...base, questionId: "q2", phrases: 0 },
    ];

    const summary = summarizeQuestion("q1", scores);

    expect(summary).toMatchObject({
      questionId: "q1",
      runs: 3,
      answered: 2,
      outcomes: { answered: 2, error: 1 },
      phrases: { n: 3, mean: 0.5, min: 0, max: 1 },
      durationMs: { n: 2, mean: 5_000, min: 4_000, max: 6_000 },
      promptTokens: { n: 2, mean: 2_500, min: 2_500, max: 2_500 },
    });
  });

  it("counts an answer that was cut off as answered", () => {
    const base = scoreRun(question, record({ events: [runEnd("answer_incomplete")] }));

    expect(summarizeQuestion("q1", [base])).toMatchObject({
      answered: 1,
      outcomes: { answer_incomplete: 1 },
    });
  });
});

describe("parseQuestions", () => {
  it("accepts questions with and without expectations", () => {
    expect(
      parseQuestions([
        { id: "q1", question: "TCP とは" },
        { id: "q-2", question: "UDP とは", expect: { phrases: ["udp"] } },
      ])
    ).toEqual([
      { id: "q1", question: "TCP とは" },
      { id: "q-2", question: "UDP とは", expect: { phrases: ["udp"] } },
    ]);
  });

  it.each<{ name: string; value: unknown; message: string }>([
    { name: "something that is not a list", value: {}, message: "non-empty array" },
    { name: "an empty list", value: [], message: "non-empty array" },
    { name: "a missing id", value: [{ question: "a" }], message: "questions[0].id" },
    {
      name: "an id with a space",
      value: [{ id: "q 1", question: "a" }],
      message: "questions[0].id",
    },
    {
      name: "a repeated id",
      value: [
        { id: "q1", question: "a" },
        { id: "q1", question: "b" },
      ],
      message: 'questions[1].id "q1" is used twice',
    },
    {
      name: "an empty question",
      value: [{ id: "q1", question: " " }],
      message: "question must be",
    },
    {
      name: "an unknown expectation",
      value: [{ id: "q1", question: "a", expect: { urls: ["/a"] } }],
      message: "unknown keys: urls",
    },
    {
      name: "a phrase that is not a string",
      value: [{ id: "q1", question: "a", expect: { phrases: [1] } }],
      message: "expect.phrases must be",
    },
    {
      name: "a full URL where a path is expected",
      value: [{ id: "q1", question: "a", expect: { urlPaths: [SLIDE_1] } }],
      message: 'paths that start with "/"',
    },
  ])("rejects $name", ({ value, message }) => {
    expect(() => parseQuestions(value)).toThrow(message);
  });
});
