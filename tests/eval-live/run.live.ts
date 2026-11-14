/**
 * live 評価の実行。実際の INIAD API と MOOCs を使うので、手で実行する（npm run eval:live）。
 * ファイル名が *.live.ts なので、npm test と CI では実行されない。
 *
 * 必要な環境変数：
 *   INIAD_API_KEY      INIAD API のキー
 *   INIAD_USERNAME     MOOCs のユーザー名（統合テストと同じ名前）
 *   INIAD_PASSWORD     MOOCs のパスワード
 * 任意の環境変数：
 *   LIVE_EVAL_RUNS       質問 1 件あたりの実行回数（既定 1）
 *   LIVE_EVAL_QUESTIONS  質問ファイルのパス（既定 questions.json、なければ questions.example.json）
 *   LIVE_EVAL_ONLY       実行する質問の id をカンマ区切りで指定
 *
 * 結果は eval-output/<日時>/ に書く。回答文には教材の内容が含まれるので、
 * このフォルダは .gitignore に入れてあり、コミットしない。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentTraceEvent } from "../../src/main/services/agent-trace";
import { ChatAgent } from "../../src/main/services/chat-agent";
import { McpClient } from "../../src/main/services/mcp-client";
import { SlidesIndexService } from "../../src/main/services/slides-index";
import { SyllabusIndexService } from "../../src/main/services/syllabus-index";
import { WebSearchClient } from "../../src/main/services/web-search-client";
import { DEFAULT_SETTINGS, type AppSettings } from "../../src/shared/types/settings";
import { formatLiveReport } from "./report";
import {
  parseQuestions,
  scoreRun,
  summarizeQuestion,
  type LiveRunRecord,
  type LiveScore,
} from "./scorers";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const apiKey = process.env.INIAD_API_KEY;
const username = process.env.INIAD_USERNAME;
const password = process.env.INIAD_PASSWORD;
const hasCredentials = Boolean(apiKey && username && password);

const runsPerQuestion = Math.max(1, Number.parseInt(process.env.LIVE_EVAL_RUNS ?? "1", 10) || 1);
const defaultQuestions = path.join(__dirname, "questions.json");
const questionsPath = process.env.LIVE_EVAL_QUESTIONS
  ? path.resolve(process.env.LIVE_EVAL_QUESTIONS)
  : existsSync(defaultQuestions)
    ? defaultQuestions
    : path.join(__dirname, "questions.example.json");
const only = new Set(
  (process.env.LIVE_EVAL_ONLY ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);
const questions = parseQuestions(JSON.parse(readFileSync(questionsPath, "utf8")) as unknown).filter(
  (question) => only.size === 0 || only.has(question.id)
);

const startedAt = new Date().toISOString();
const outputDir = path.join(REPO_ROOT, "eval-output", startedAt.replace(/[:.]/g, "-"));
const settings: AppSettings = { ...DEFAULT_SETTINGS, apiKey: apiKey ?? "" };
const scores: LiveScore[] = [];

describe.skipIf(!hasCredentials)("live evaluation (real API and MOOCs; run by hand)", () => {
  let mcpClient: McpClient;
  let agent: ChatAgent;

  beforeAll(async () => {
    mkdirSync(outputDir, { recursive: true });
    mcpClient = new McpClient();
    await mcpClient.connect(username!, password!);
    // アプリと同じ組み立て。索引は data/ から読む（テストでは既定の場所を解決できないため）。
    const syllabus = new SyllabusIndexService();
    const slides = new SlidesIndexService();
    syllabus.load(path.join(REPO_ROOT, "data", "syllabus-index.json"));
    slides.load(path.join(REPO_ROOT, "data", "slides-index.json"));
    agent = new ChatAgent(mcpClient, new WebSearchClient(), syllabus, slides);
  });

  afterAll(async () => {
    await mcpClient?.disconnect();
    if (scores.length === 0) return;
    const summaries = questions.map((question) => summarizeQuestion(question.id, scores));
    const meta = {
      startedAt,
      model: settings.model,
      runsPerQuestion,
      questionsFile: path.basename(questionsPath),
    };
    writeFileSync(
      path.join(outputDir, "summary.json"),
      `${JSON.stringify({ meta, summaries, scores }, null, 2)}\n`
    );
    const report = formatLiveReport(meta, summaries);
    writeFileSync(path.join(outputDir, "summary.md"), report);
    console.log(`\n${report}\n結果の保存先: ${outputDir}`);
  });

  const cases = questions.flatMap((question) =>
    Array.from({ length: runsPerQuestion }, (_, index) => ({ question, attempt: index + 1 }))
  );

  // 各実行は会話履歴も過去の資料も持たない、独立した 1 問として行う。
  it.each(cases)("$question.id (run $attempt)", async ({ question, attempt }) => {
    const events: AgentTraceEvent[] = [];
    const response = await agent
      .chat(question.question, settings, undefined, undefined, {
        traceSinks: [(event) => events.push(event)],
      })
      .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));

    const record: LiveRunRecord =
      response instanceof Error
        ? {
            questionId: question.id,
            attempt,
            answer: "",
            citations: [],
            error: response.message,
            events,
          }
        : {
            questionId: question.id,
            attempt,
            answer: response.content,
            citations: response.citations.map((citation) => citation.url),
            ...(response.completion ? { completion: response.completion } : {}),
            events,
          };
    const score = scoreRun(question, record);
    scores.push(score);
    writeFileSync(
      path.join(outputDir, `${question.id}-run${attempt}.json`),
      `${JSON.stringify({ question, record, score }, null, 2)}\n`
    );

    // 点数は報告するだけで、合否にはしない。記録が最後まで取れたことだけを確かめる。
    expect(score.metrics.outcome).not.toBe("no_run_end");
  });
});
