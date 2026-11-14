/**
 * live 評価の採点。実 API と実 MOOCs で得た 1 回分の結果（回答、引用、実行の記録）を、
 * 質問ごとの期待値と比べて点数にする。関数はすべて純粋で、ネットワークを使わない。
 *
 * 期待値（期待するツール、期待する URL、必須の語句）は質問ごとに任意。
 * 書かれていない観点の点数は null になり、平均にも入らない。
 * 期待値がなくても、時間・回数・トークン数などの計測値は必ず出る。
 */
import type { AgentTraceEvent } from "../../src/main/services/agent-trace";

/** 評価する質問 1 件。expect は任意で、正解ラベルがなくても実行できる。 */
export interface LiveQuestion {
  id: string;
  question: string;
  expect?: {
    /** 成功していてほしいツール名（例: moocs_read_slide） */
    tools?: string[];
    /** 引用に入っていてほしい URL のパス（例: /courses/2026/XXX/01/01） */
    urlPaths?: string[];
    /** 回答に入っていてほしい語句 */
    phrases?: string[];
  };
}

/** 1 回の実行で得たもの。answer と citations は失敗時には空。 */
export interface LiveRunRecord {
  questionId: string;
  /** 同じ質問の何回目の実行か（1 始まり） */
  attempt: number;
  answer: string;
  citations: string[];
  /** 回答が途中で終わった理由。最後まで書かれていれば undefined。 */
  completion?: string;
  /** 失敗した場合のエラー文 */
  error?: string;
  events: AgentTraceEvent[];
}

export interface LiveMetrics {
  /** run_end の reason。記録がなければ "no_run_end" */
  outcome: string;
  durationMs: number | null;
  iterations: number;
  /** 実際に実行したツール呼び出しの数 */
  toolCalls: number;
  /** 失敗で終わったツール呼び出しの数（拒否されたものを含む） */
  failedToolCalls: number;
  /** 同じ URL を 2 回以上読んだ回数（2 回目以降を数える） */
  repeatedReads: number;
  /** usage の合計。API が usage を返さなかった呼び出しがあれば null */
  promptTokens: number | null;
  completionTokens: number | null;
  answerChars: number;
  citations: number;
}

export interface LiveScore {
  questionId: string;
  attempt: number;
  /** 期待したツールのうち成功したものの割合（0〜1）。期待値がなければ null */
  tools: number | null;
  /** 期待した URL のうち引用に入ったものの割合。期待値がなければ null */
  urlPaths: number | null;
  /** 期待した語句のうち回答に入ったものの割合。期待値がなければ null */
  phrases: number | null;
  /** 期待したのに満たされなかったもの。結果を見直すときの手がかり。 */
  missing: { tools: string[]; urlPaths: string[]; phrases: string[] };
  metrics: LiveMetrics;
}

/** 比較用に文字をそろえる。全角と半角、大文字と小文字、空白の違いを無視する。 */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/** URL からパスだけを取り出す。末尾のスラッシュは落とす。読めない URL は null。 */
export function urlPathOf(url: string): string | null {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path === "" ? "/" : path;
  } catch {
    return null;
  }
}

function fraction<T>(
  expected: readonly T[] | undefined,
  isMet: (item: T) => boolean
): {
  score: number | null;
  missing: T[];
} {
  if (!expected?.length) return { score: null, missing: [] };
  const missing = expected.filter((item) => !isMet(item));
  return { score: (expected.length - missing.length) / expected.length, missing };
}

export function measureRun(record: LiveRunRecord): LiveMetrics {
  const { events } = record;
  const runEnd = events.find((event) => event.type === "run_end");
  const llmEnds = events.filter((event) => event.type === "llm_end");
  const toolEnds = events.filter((event) => event.type === "tool_end");

  const readPaths = events.flatMap((event) =>
    event.type === "tool_start" && event.tool === "moocs_read_slide" && event.args.urlPath
      ? [event.args.urlPath]
      : []
  );
  const everyCallHasUsage =
    llmEnds.length > 0 && llmEnds.every((event) => event.type === "llm_end" && event.usage);
  const sumUsage = (key: "promptTokens" | "completionTokens"): number | null => {
    if (!everyCallHasUsage) return null;
    let total = 0;
    for (const event of llmEnds) {
      const value = event.type === "llm_end" ? event.usage?.[key] : null;
      if (value === null || value === undefined) return null;
      total += value;
    }
    return total;
  };

  return {
    outcome: runEnd?.type === "run_end" ? runEnd.reason : "no_run_end",
    durationMs: runEnd?.type === "run_end" ? runEnd.durationMs : null,
    iterations: runEnd?.type === "run_end" ? runEnd.iterations : llmEnds.length,
    toolCalls: runEnd?.type === "run_end" ? runEnd.toolCalls : toolEnds.length,
    failedToolCalls: toolEnds.filter((event) => event.type === "tool_end" && !event.outcome.ok)
      .length,
    repeatedReads: readPaths.length - new Set(readPaths).size,
    promptTokens: sumUsage("promptTokens"),
    completionTokens: sumUsage("completionTokens"),
    answerChars: record.answer.length,
    citations: record.citations.length,
  };
}

export function scoreRun(question: LiveQuestion, record: LiveRunRecord): LiveScore {
  const succeededTools = new Set(
    record.events.flatMap((event) =>
      event.type === "tool_end" && event.outcome.ok ? [event.tool] : []
    )
  );
  const citedPaths = new Set(
    record.citations.map(urlPathOf).filter((path): path is string => path !== null)
  );
  const answer = normalizeText(record.answer);

  const tools = fraction(question.expect?.tools, (tool) => succeededTools.has(tool));
  const urlPaths = fraction(question.expect?.urlPaths, (path) =>
    citedPaths.has(path.replace(/\/+$/, "") || "/")
  );
  const phrases = fraction(question.expect?.phrases, (phrase) =>
    answer.includes(normalizeText(phrase))
  );

  return {
    questionId: record.questionId,
    attempt: record.attempt,
    tools: tools.score,
    urlPaths: urlPaths.score,
    phrases: phrases.score,
    missing: { tools: tools.missing, urlPaths: urlPaths.missing, phrases: phrases.missing },
    metrics: measureRun(record),
  };
}

export interface Spread {
  /** 値のあった実行の数 */
  n: number;
  mean: number;
  min: number;
  max: number;
}

/** 値のあるものだけで平均・最小・最大を出す。1 つもなければ null。 */
export function spreadOf(values: ReadonlyArray<number | null>): Spread | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return {
    n: present.length,
    mean: present.reduce((sum, value) => sum + value, 0) / present.length,
    min: Math.min(...present),
    max: Math.max(...present),
  };
}

export interface QuestionSummary {
  questionId: string;
  runs: number;
  /** 回答を返した実行の数（answered と answer_incomplete） */
  answered: number;
  /** 終わり方ごとの回数 */
  outcomes: Record<string, number>;
  tools: Spread | null;
  urlPaths: Spread | null;
  phrases: Spread | null;
  durationMs: Spread | null;
  toolCalls: Spread | null;
  repeatedReads: Spread | null;
  promptTokens: Spread | null;
  completionTokens: Spread | null;
}

/**
 * 同じ質問を複数回実行した結果をまとめる。モデルは毎回ちがう答え方をするので、
 * 変更の前後を比べるときは平均だけでなく最小と最大の幅を見る。
 */
export function summarizeQuestion(
  questionId: string,
  scores: readonly LiveScore[]
): QuestionSummary {
  const own = scores.filter((score) => score.questionId === questionId);
  const outcomes: Record<string, number> = {};
  for (const score of own) {
    outcomes[score.metrics.outcome] = (outcomes[score.metrics.outcome] ?? 0) + 1;
  }
  return {
    questionId,
    runs: own.length,
    answered: (outcomes.answered ?? 0) + (outcomes.answer_incomplete ?? 0),
    outcomes,
    tools: spreadOf(own.map((score) => score.tools)),
    urlPaths: spreadOf(own.map((score) => score.urlPaths)),
    phrases: spreadOf(own.map((score) => score.phrases)),
    durationMs: spreadOf(own.map((score) => score.metrics.durationMs)),
    toolCalls: spreadOf(own.map((score) => score.metrics.toolCalls)),
    repeatedReads: spreadOf(own.map((score) => score.metrics.repeatedReads)),
    promptTokens: spreadOf(own.map((score) => score.metrics.promptTokens)),
    completionTokens: spreadOf(own.map((score) => score.metrics.completionTokens)),
  };
}

/** 質問の一覧として読めるかを確かめる。読めなければ理由つきで例外にする。 */
export function parseQuestions(value: unknown): LiveQuestion[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("questions must be a non-empty array");
  }
  const seen = new Set<string>();
  const isStrings = (item: unknown): item is string[] =>
    Array.isArray(item) && item.every((entry) => typeof entry === "string" && entry.length > 0);

  return value.map((raw: unknown, index) => {
    const where = `questions[${index}]`;
    if (!raw || typeof raw !== "object") throw new Error(`${where} must be an object`);
    const { id, question, expect } = raw as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(`${where}.id must be lower-case letters, digits and hyphens`);
    }
    if (seen.has(id)) throw new Error(`${where}.id "${id}" is used twice`);
    seen.add(id);
    if (typeof question !== "string" || !question.trim()) {
      throw new Error(`${where}.question must be a non-empty string`);
    }
    if (expect === undefined) return { id, question };
    if (!expect || typeof expect !== "object" || Array.isArray(expect)) {
      throw new Error(`${where}.expect must be an object`);
    }
    const { tools, urlPaths, phrases, ...rest } = expect as Record<string, unknown>;
    const unknownKeys = Object.keys(rest);
    if (unknownKeys.length > 0) {
      throw new Error(`${where}.expect has unknown keys: ${unknownKeys.join(", ")}`);
    }
    for (const [key, list] of Object.entries({ tools, urlPaths, phrases })) {
      if (list !== undefined && !isStrings(list)) {
        throw new Error(`${where}.expect.${key} must be an array of non-empty strings`);
      }
    }
    if (isStrings(urlPaths) && urlPaths.some((path) => !path.startsWith("/"))) {
      throw new Error(`${where}.expect.urlPaths must be paths that start with "/"`);
    }
    return {
      id,
      question,
      expect: {
        ...(isStrings(tools) ? { tools } : {}),
        ...(isStrings(urlPaths) ? { urlPaths } : {}),
        ...(isStrings(phrases) ? { phrases } : {}),
      },
    };
  });
}
