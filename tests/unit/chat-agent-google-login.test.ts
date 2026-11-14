/**
 * スライドを読む前の Google ログインが、質問 1 件につき 1 回だけ行われることを、
 * エージェントのループを通して確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAgent } from "../../src/main/services/chat-agent";
import type { McpClient } from "../../src/main/services/mcp-client";
import type { AppSettings } from "../../src/shared/types/settings";
import { installFakeLlm } from "../helpers/fake-llm";

const settings: AppSettings = {
  apiKey: "test-key",
  baseURL: "https://api.openai.iniad.org/api/v1",
  model: "gpt-test",
  moocsUsername: "",
  moocsPassword: "",
};

const BASE = "https://moocs.iniad.org/courses/2099/TEST101/vod01";
const TEXT = "合成スライド。これは架空の本文で、実在の教材ではない。架空の用語アルファを説明する。";

function slideMcp(): McpClient {
  let currentUrl = "";
  return {
    getStatus: vi.fn().mockReturnValue("connected"),
    ping: vi.fn().mockResolvedValue(true),
    navigateTo: vi.fn(async (url: string) => {
      currentUrl = url;
    }),
    loginToGoogle: vi.fn().mockResolvedValue(undefined),
    expandSlideTab: vi.fn().mockResolvedValue(undefined),
    extractGoogleSlideText: vi.fn(async () => ({
      content: [{ type: "text", text: JSON.stringify({ moocsUrl: currentUrl, text: TEXT }) }],
    })),
    callToolSafe: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  } as unknown as McpClient;
}

function readSlide(id: string, page: number) {
  return {
    id,
    name: "moocs_read_slide",
    arguments: JSON.stringify({ url: `${BASE}/0${page}` }),
  };
}

describe("ChatAgent Google login before reading slides", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("logs in once per question, however many slides are read", async () => {
    installFakeLlm((index) =>
      index === 0
        ? { toolCalls: [readSlide("call_0", 1), readSlide("call_1", 2)] }
        : index === 1
          ? { toolCalls: [readSlide("call_2", 3)] }
          : { content: "回答です。" }
    );
    const mcp = slideMcp();
    const agent = new ChatAgent(mcp, { search: vi.fn() });

    const result = await agent.chat("質問", settings);

    expect(mcp.extractGoogleSlideText).toHaveBeenCalledTimes(3);
    expect(mcp.loginToGoogle).toHaveBeenCalledTimes(1);
    expect(result.citations.map((citation) => citation.url)).toEqual([
      `${BASE}/01`,
      `${BASE}/02`,
      `${BASE}/03`,
    ]);
  });

  it("logs in again for the next question", async () => {
    installFakeLlm((index) =>
      index % 2 === 0 ? { toolCalls: [readSlide(`call_${index}`, 1)] } : { content: "回答です。" }
    );
    const mcp = slideMcp();
    const agent = new ChatAgent(mcp, { search: vi.fn() });

    await agent.chat("1問目", settings);
    await agent.chat("2問目", settings);

    expect(mcp.loginToGoogle).toHaveBeenCalledTimes(2);
  });

  it("does not log in for a question that reads no slides", async () => {
    installFakeLlm((index) =>
      index === 0
        ? { toolCalls: [{ id: "call_0", name: "moocs_list_courses", arguments: "{}" }] }
        : { content: "回答です。" }
    );
    const mcp = slideMcp();
    const agent = new ChatAgent(mcp, { search: vi.fn() });

    await agent.chat("質問", settings);

    expect(mcp.loginToGoogle).not.toHaveBeenCalled();
  });
});
