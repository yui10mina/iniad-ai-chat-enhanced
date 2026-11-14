/**
 * live 評価の結果を、人が読む表（Markdown）にする。純粋な関数で、ネットワークを使わない。
 */
import type { QuestionSummary, Spread } from "./scorers";

export interface LiveReportMeta {
  /** 実行した日時（ISO 8601） */
  startedAt: string;
  model: string;
  /** 質問 1 件あたりの実行回数 */
  runsPerQuestion: number;
  /** 使った質問ファイルの名前 */
  questionsFile: string;
}

function percent(spread: Spread | null): string {
  if (!spread) return "—";
  const format = (value: number) => `${Math.round(value * 100)}%`;
  return spread.min === spread.max
    ? format(spread.mean)
    : `${format(spread.mean)} (${format(spread.min)}–${format(spread.max)})`;
}

function amount(spread: Spread | null, digits = 0, unit = ""): string {
  if (!spread) return "—";
  const format = (value: number) => `${value.toFixed(digits)}${unit}`;
  return spread.min === spread.max
    ? format(spread.mean)
    : `${format(spread.mean)} (${format(spread.min)}–${format(spread.max)})`;
}

function seconds(spread: Spread | null): string {
  if (!spread) return "—";
  return amount(
    { ...spread, mean: spread.mean / 1000, min: spread.min / 1000, max: spread.max / 1000 },
    1,
    "s"
  );
}

/**
 * 質問ごとの表を作る。値は「平均（最小–最大）」で、実行が 1 回か全部同じ値なら平均だけを出す。
 * 期待値のない観点と、値を取れなかった計測は「—」にする。
 */
export function formatLiveReport(
  meta: LiveReportMeta,
  summaries: readonly QuestionSummary[]
): string {
  const header = [
    "| 質問 | 回答できた回数 | ツール | URL | 語句 | 時間 | ツール回数 | 読み直し | 入力トークン |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  const rows = summaries.map((summary) =>
    [
      "",
      summary.questionId,
      `${summary.answered}/${summary.runs}`,
      percent(summary.tools),
      percent(summary.urlPaths),
      percent(summary.phrases),
      seconds(summary.durationMs),
      amount(summary.toolCalls, 1),
      amount(summary.repeatedReads, 1),
      amount(summary.promptTokens),
      "",
    ]
      .join(" | ")
      .trim()
  );

  return [
    "# live 評価の結果",
    "",
    `- 実行日時：${meta.startedAt}`,
    `- モデル：${meta.model}`,
    `- 質問ファイル：${meta.questionsFile}`,
    `- 質問 1 件あたりの実行回数：${meta.runsPerQuestion}`,
    "",
    "値は「平均（最小–最大）」です。ツール・URL・語句は、期待したもののうち満たされた割合です。",
    "モデルは毎回ちがう答え方をするので、変更の前後を比べるときは幅を見てください。",
    "",
    ...header,
    ...rows,
    "",
  ].join("\n");
}
