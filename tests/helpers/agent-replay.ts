/**
 * 合成データのシナリオを、本物のエージェントループに流す（replay）。
 *
 * AI の応答と MOOCs のページは台本（fixture）で決まっていて、ネットワークも認証情報も使わない。
 * 確かめるのはループの動き（何を何回呼び、何を残し、どう終わるか）で、回答の品質ではない。
 * 回答文は台本に書いた文字列がそのまま返るだけなので、良し悪しは測れない。
 */
import { vi } from "vitest";
import type { AgentTraceEvent } from "../../src/main/services/agent-trace";
import {
  ChatAgent,
  UNTRUSTED_REFERENCE_END,
  UNTRUSTED_REFERENCE_START,
} from "../../src/main/services/chat-agent";
import type { McpClient } from "../../src/main/services/mcp-client";
import type { AppSettings } from "../../src/shared/types/settings";
import { installFakeLlm, toolNames, type FakeReply, type SentRequest } from "./fake-llm";

/** 台本の 1 ページ。slideText は Google スライドの本文、snapshot は HTML ページの内容。 */
export interface ReplayPage {
  slideText?: string;
  snapshot?: string;
}

/** 台本の AI の応答 1 回分。 */
export interface ReplayReply {
  content?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  finishReason?: string;
  /** この回の API 呼び出しを HTTP エラーにする */
  httpError?: number;
  /** この回の応答に付ける入力トークン数。省略すると usage のない応答になる。 */
  promptTokens?: number;
}

/** 実行結果の要約。fixture の expect と丸ごと比べる。 */
export interface ReplaySummary {
  /** run_end の reason */
  outcome: string;
  answer?: string;
  completion?: string;
  errorMessage?: string;
  llmCalls: number;
  /** ツール呼び出しごとの「ツール名 パス -> 結果」 */
  tools: string[];
  /** 回答に付いた引用の URL */
  citations: string[];
  /** 資料として保存に回された URL */
  materials: string[];
  /** 実際に行われた Web 検索の回数 */
  webSearches: number;
  lastRequest: {
    /** 最後の API 呼び出しで渡したツール名。渡していなければ空。 */
    toolsOffered: string[];
    /** ツール結果ごとに、本文が残っているか（kept）省略されたか（omitted） */
    toolResults: Array<"kept" | "omitted">;
  };
  /** 本文の残っているツール結果が、どの API 呼び出しでも境界で正しく包まれているか */
  toolResultsWrapped: boolean;
  /** 時間かトークンの予算を超えて調査を打ち切った場合の、超えた予算。超えていなければ付かない。 */
  exceededBudget?: string;
}

export interface ReplayFixture {
  name: string;
  description: string;
  question: string;
  pages: Record<string, ReplayPage>;
  llm: ReplayReply[];
  expect: ReplaySummary;
}

export interface ReplayRun {
  summary: ReplaySummary;
  requests: SentRequest[];
  events: AgentTraceEvent[];
}

const SETTINGS: AppSettings = {
  apiKey: "replay-key",
  baseURL: "https://api.openai.iniad.org/api/v1",
  model: "replay-model",
  moocsUsername: "",
  moocsPassword: "",
};

const OMITTED_MARK = "[以前のツール結果は省略";
const OMITTED_MATERIAL_HEADER = `${UNTRUSTED_REFERENCE_START} type=OMITTED_TOOL_RESULT\n`;

/** 本文が省略されたツール結果か。資料の省略は、題名と URL を境界の中に残した形になる。 */
function isOmitted(content: string): boolean {
  return content.startsWith(OMITTED_MARK) || content.startsWith(OMITTED_MATERIAL_HEADER);
}
const TOOL_RESULT_HEADER = `${UNTRUSTED_REFERENCE_START} type=CURRENT_TOOL_RESULT\n`;

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

/** 台本のページを返す MCP の偽物。最後に開いた URL を覚えて、その内容を返す。 */
function replayMcp(pages: Record<string, ReplayPage>): McpClient {
  let currentUrl = "";
  return {
    getStatus: () => "connected",
    ping: async () => true,
    ensureMoocsLogin: async () => textResult("logged in"),
    loginToMoocs: async () => textResult("logged in"),
    navigateTo: async (url: string) => {
      currentUrl = url;
    },
    expandSlideTab: async () => undefined,
    extractGoogleSlideText: async () => {
      const page = pages[currentUrl];
      return textResult(
        JSON.stringify(
          page?.slideText
            ? { moocsUrl: currentUrl, text: page.slideText }
            : { error: "no_google_slides_iframe" }
        )
      );
    },
    getPageSnapshot: async () => pages[currentUrl]?.snapshot ?? "",
    callToolSafe: async (name: string) => textResult(`${name}: ok`),
  } as unknown as McpClient;
}

function toFakeReply(reply: ReplayReply, requestIndex: number): FakeReply {
  return {
    content: reply.content,
    finishReason: reply.finishReason,
    httpError: reply.httpError,
    ...(reply.promptTokens === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: reply.promptTokens,
            completion_tokens: 0,
            total_tokens: reply.promptTokens,
          },
        }),
    toolCalls: reply.toolCalls?.map((call, callIndex) => ({
      id: `call_${requestIndex}_${callIndex}`,
      name: call.name,
      arguments: JSON.stringify(call.args),
    })),
  };
}

function isWrappedToolResult(content: string): boolean {
  const body = content.slice(TOOL_RESULT_HEADER.length, -UNTRUSTED_REFERENCE_END.length);
  return (
    content.startsWith(TOOL_RESULT_HEADER) &&
    content.endsWith(`\n${UNTRUSTED_REFERENCE_END}`) &&
    !body.includes(UNTRUSTED_REFERENCE_START) &&
    !body.includes(UNTRUSTED_REFERENCE_END)
  );
}

export async function runReplay(fixture: ReplayFixture): Promise<ReplayRun> {
  const llm = installFakeLlm((index) => {
    const reply = fixture.llm[index];
    if (!reply) throw new Error(`${fixture.name}: the script has no reply for request ${index}`);
    return toFakeReply(reply, index);
  });
  const search = vi.fn().mockResolvedValue({ success: true, results: [] });
  const events: AgentTraceEvent[] = [];
  const materials: string[] = [];
  const agent = new ChatAgent(replayMcp(fixture.pages), { search });

  const result = await agent
    .chat(fixture.question, SETTINGS, undefined, undefined, {
      traceSinks: [(event) => events.push(event)],
      onMaterialsRetrieved: (retrieved) => materials.push(...retrieved.map((m) => m.url)),
    })
    .catch((error: unknown) => error as Error);

  const runEnd = events.find((event) => event.type === "run_end");
  const tools = events.flatMap((event) => {
    if (event.type !== "tool_end") return [];
    const start = events.find(
      (other) => other.type === "tool_start" && other.sequence === event.sequence
    );
    const path = start?.type === "tool_start" ? (start.args.urlPath ?? "") : "";
    return [`${event.tool} ${path}`.trim() + ` -> ${event.outcome.code}`];
  });
  const lastRequest = llm.requests[llm.requests.length - 1];
  const toolMessages = (request: SentRequest) =>
    request.messages.filter((message) => message.role === "tool");

  const summary: ReplaySummary = {
    outcome: runEnd?.type === "run_end" ? runEnd.reason : "no run_end",
    ...(result instanceof Error
      ? { errorMessage: result.message }
      : {
          answer: result.content,
          ...(result.completion ? { completion: result.completion } : {}),
        }),
    llmCalls: llm.requests.length,
    tools,
    citations: result instanceof Error ? [] : result.citations.map((citation) => citation.url),
    materials,
    webSearches: search.mock.calls.length,
    lastRequest: {
      toolsOffered: toolNames(lastRequest),
      toolResults: toolMessages(lastRequest).map((message) =>
        isOmitted(String(message.content)) ? "omitted" : "kept"
      ),
    },
    toolResultsWrapped: llm.requests.every((request) =>
      toolMessages(request)
        .map((message) => String(message.content))
        .filter((content) => !isOmitted(content))
        .every(isWrappedToolResult)
    ),
    ...(runEnd?.type === "run_end" && runEnd.exceededBudget
      ? { exceededBudget: runEnd.exceededBudget }
      : {}),
  };
  return { summary, requests: llm.requests, events };
}
