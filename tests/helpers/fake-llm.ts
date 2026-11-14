import { vi, type Mock } from "vitest";

/**
 * Chat Completions API の偽物。fetch を差し替え、送られた body を記録し、
 * 台本どおりの応答を返す。ループの検証は「API に送った body」と「chat の戻り値」だけで行う。
 */

export interface SentMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface SentRequest {
  model: string;
  messages: SentMessage[];
  tools?: Array<{ function: { name: string } }>;
  tool_choice?: string;
  [key: string]: unknown;
}

export interface FakeToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface FakeReply {
  content?: string | null;
  toolCalls?: FakeToolCall[];
  /** 省略すると tool_calls か stop。null のときは finish_reason を応答に入れない。 */
  finishReason?: string | null;
  /** 応答に付ける usage。省略すると usage のない応答になる。 */
  usage?: Record<string, unknown>;
}

export interface FakeLlm {
  fetch: Mock;
  /** 送られた順のリクエスト body */
  requests: SentRequest[];
}

/**
 * @param reply 何回目（0 始まり）のリクエストか、と送られた body から応答を決める。
 */
export function installFakeLlm(reply: (index: number, request: SentRequest) => FakeReply): FakeLlm {
  const requests: SentRequest[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const request = JSON.parse(String(init?.body)) as SentRequest;
    const index = requests.length;
    requests.push(request);
    const { content = null, toolCalls, finishReason, usage } = reply(index, request);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content,
              ...(toolCalls
                ? {
                    tool_calls: toolCalls.map((call) => ({
                      id: call.id,
                      type: "function",
                      function: { name: call.name, arguments: call.arguments },
                    })),
                  }
                : {}),
            },
            ...(finishReason === null
              ? {}
              : { finish_reason: finishReason ?? (toolCalls ? "tool_calls" : "stop") }),
          },
        ],
        ...(usage ? { usage } : {}),
      }),
    };
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, requests };
}

/** 呼び出しごとに URL を変えた moocs_navigate。同じ引数の繰り返しにしないため。 */
export function navigateCall(id: string, page: number): FakeToolCall {
  return {
    id,
    name: "moocs_navigate",
    arguments: JSON.stringify({ url: `https://moocs.iniad.org/courses/2026/TEST/${page}` }),
  };
}

export function toolNames(request: SentRequest): string[] {
  return request.tools?.map((tool) => tool.function.name) ?? [];
}

export function lastMessage(request: SentRequest): SentMessage {
  return request.messages[request.messages.length - 1];
}
