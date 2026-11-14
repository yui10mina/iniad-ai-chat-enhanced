import { describe, expect, it } from "vitest";
import { formatLiveReport } from "./report";
import type { QuestionSummary } from "./scorers";

const meta = {
  startedAt: "2026-11-14T09:00:00.000Z",
  model: "gpt-test",
  runsPerQuestion: 3,
  questionsFile: "questions.example.json",
};

const summary: QuestionSummary = {
  questionId: "q1",
  runs: 3,
  answered: 2,
  outcomes: { answered: 2, error: 1 },
  tools: { n: 3, mean: 1, min: 1, max: 1 },
  urlPaths: { n: 3, mean: 2 / 3, min: 0, max: 1 },
  phrases: null,
  durationMs: { n: 2, mean: 30_500, min: 28_000, max: 33_000 },
  toolCalls: { n: 3, mean: 8, min: 8, max: 8 },
  repeatedReads: { n: 3, mean: 4 / 3, min: 0, max: 2 },
  promptTokens: null,
  completionTokens: null,
};

describe("formatLiveReport", () => {
  it("records when, with which model and how many runs", () => {
    const report = formatLiveReport(meta, [summary]);

    expect(report).toContain("- 実行日時：2026-11-14T09:00:00.000Z");
    expect(report).toContain("- モデル：gpt-test");
    expect(report).toContain("- 質問 1 件あたりの実行回数：3");
    expect(report).toContain("- 質問ファイル：questions.example.json");
  });

  it("shows the mean with its range, the mean alone when all runs agree, and a dash for no value", () => {
    const row = formatLiveReport(meta, [summary])
      .split("\n")
      .find((line) => line.startsWith("| q1 |"));

    expect(row).toBe(
      "| q1 | 2/3 | 100% | 67% (0%–100%) | — | 30.5s (28.0s–33.0s) | 8.0 | 1.3 (0.0–2.0) | — |"
    );
  });

  it("has one row per question under the header", () => {
    const lines = formatLiveReport(meta, [summary, { ...summary, questionId: "q2" }]).split("\n");
    const header = lines.findIndex((line) => line.startsWith("| 質問 |"));

    expect(lines.slice(header + 2, header + 4).map((line) => line.split(" | ")[0])).toEqual([
      "| q1",
      "| q2",
    ]);
  });
});
