import { beforeEach, describe, it, expect, vi } from "vitest";
import { executeAgentTool } from "../../src/main/services/moocs-tool-executor";
import type { McpClient } from "../../src/main/services/mcp-client";
import type { IWebSearchProvider } from "../../src/main/services/web-search-types";

function createMcpMock(overrides: Partial<McpClient> = {}): McpClient {
  return {
    getStatus: vi.fn().mockReturnValue("connected"),
    ping: vi.fn().mockResolvedValue(true),
    loginToMoocs: vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '[{"title":"Python基礎","url":"https://moocs.iniad.org/courses/python"}]',
        },
      ],
    }),
    ensureMoocsLogin: vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '[{"title":"Python基礎","url":"https://moocs.iniad.org/courses/python"}]',
        },
      ],
    }),
    navigateTo: vi.fn().mockResolvedValue(undefined),
    expandSlideTab: vi.fn().mockResolvedValue(undefined),
    extractGoogleSlideText: vi.fn().mockResolvedValue({ content: [] }),
    callToolSafe: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    }),
    getPageSnapshot: vi.fn().mockResolvedValue("スライド本文です"),
    ...overrides,
  } as unknown as McpClient;
}

const webClient: IWebSearchProvider = {
  search: vi.fn().mockResolvedValue({
    success: true,
    results: [{ title: "Web", url: "https://example.com", snippet: "info", source: "web" }],
  }),
};

describe("executeAgentTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when MCP is not connected", async () => {
    const result = await executeAgentTool("moocs_list_courses", "{}", {
      mcpClient: createMcpMock({ getStatus: vi.fn().mockReturnValue("disconnected") }),
      webClient,
      mcpConnected: false,
    });

    expect(result.content).toContain("not connected");
  });

  it("executes moocs_login with the remembered login and extracts citations", async () => {
    const mcpClient = createMcpMock();
    const result = await executeAgentTool("moocs_login", "{}", {
      mcpClient,
      webClient,
      mcpConnected: true,
    });

    expect(mcpClient.ensureMoocsLogin).toHaveBeenCalled();
    expect(mcpClient.loginToMoocs).not.toHaveBeenCalled();
    expect(result.content).toContain("Python基礎");
    expect(result.citations.some((c) => c.url.includes("moocs.iniad.org"))).toBe(true);
  });

  it("logs in for real when moocs_login is called again in the same chat", async () => {
    const mcpClient = createMcpMock();
    const moocsLoginState = { called: false };
    const ctx = { mcpClient, webClient, mcpConnected: true, moocsLoginState };

    await executeAgentTool("moocs_login", "{}", ctx);
    expect(mcpClient.ensureMoocsLogin).toHaveBeenCalledTimes(1);
    expect(mcpClient.loginToMoocs).not.toHaveBeenCalled();

    // 2 回目はセッション切れを疑っての呼び出しなので、覚えている結果を使わない。
    await executeAgentTool("moocs_login", "{}", ctx);
    expect(mcpClient.ensureMoocsLogin).toHaveBeenCalledTimes(1);
    expect(mcpClient.loginToMoocs).toHaveBeenCalledTimes(1);
  });

  it("logs in for real when moocs_login comes after another MOOCs tool in the same chat", async () => {
    const mcpClient = createMcpMock();
    const ctx = { mcpClient, webClient, mcpConnected: true, moocsLoginState: { called: false } };

    await executeAgentTool("moocs_list_courses", "{}", ctx);
    await executeAgentTool("moocs_login", "{}", ctx);

    expect(mcpClient.ensureMoocsLogin).not.toHaveBeenCalled();
    expect(mcpClient.loginToMoocs).toHaveBeenCalledTimes(1);
  });

  it("rejects non-moocs URLs for moocs_navigate", async () => {
    const result = await executeAgentTool(
      "moocs_navigate",
      JSON.stringify({ url: "https://evil.example.com" }),
      { mcpClient: createMcpMock(), webClient, mcpConnected: true }
    );

    expect(result.content).toContain("moocs.iniad.org");
  });

  it("executes web_search without MCP", async () => {
    const result = await executeAgentTool("web_search", JSON.stringify({ query: "INIAD" }), {
      mcpClient: createMcpMock(),
      webClient,
      mcpConnected: false,
    });

    expect(result.content).toContain("Web");
    expect(webClient.search).toHaveBeenCalledWith("INIAD");
    expect(result.materials).toBeUndefined();
    expect(result.citations).toEqual([
      expect.objectContaining({ title: "Web", url: "https://example.com", sourceType: "web" }),
    ]);
  });

  it("bounds web metadata and drops unsafe result URLs", async () => {
    const boundedWebClient: IWebSearchProvider = {
      search: vi.fn().mockResolvedValue({
        success: true,
        results: [
          {
            title: "T".repeat(300),
            url: "https://example.com/article",
            snippet: "S".repeat(700),
            source: "web",
          },
          {
            title: "unsafe",
            url: "javascript:alert(1)",
            snippet: "must be dropped",
            source: "web",
          },
        ],
      }),
    };

    const result = await executeAgentTool("web_search", '{"query":"INIAD"}', {
      mcpClient: createMcpMock(),
      webClient: boundedWebClient,
      mcpConnected: false,
    });

    expect(result.materials).toBeUndefined();
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].title).toHaveLength(200);
    expect(result.citations[0].snippet).toHaveLength(500);
    expect(result.content).not.toContain("javascript:");
  });

  it("rejects extra keys and wrong argument types without coercion", async () => {
    const mcpClient = createMcpMock();
    const login = await executeAgentTool("moocs_login", '{"extra":true}', {
      mcpClient,
      webClient,
      mcpConnected: true,
    });
    const navigate = await executeAgentTool("moocs_navigate", '{"url":123}', {
      mcpClient,
      webClient,
      mcpConnected: true,
    });
    const read = await executeAgentTool(
      "moocs_read_slide",
      '{"url":"https://moocs.iniad.org/courses/2026/COS201/01/01","extra":true}',
      { mcpClient, webClient, mcpConnected: true }
    );
    const search = await executeAgentTool("web_search", '{"query":123}', {
      mcpClient,
      webClient,
      mcpConnected: false,
    });

    expect(login.content).toContain("does not accept arguments");
    expect(navigate.content).toContain("non-empty string");
    expect(read.content).toContain("accepts only url");
    expect(search.content).toContain("non-empty string");
    expect(mcpClient.loginToMoocs).not.toHaveBeenCalled();
    expect(mcpClient.ensureMoocsLogin).not.toHaveBeenCalled();
    expect(mcpClient.navigateTo).not.toHaveBeenCalled();
    expect(mcpClient.expandSlideTab).not.toHaveBeenCalled();
    expect(mcpClient.extractGoogleSlideText).not.toHaveBeenCalled();
    expect(mcpClient.ping).not.toHaveBeenCalled();
    expect(mcpClient.callToolSafe).not.toHaveBeenCalled();
    expect(webClient.search).not.toHaveBeenCalled();
  });

  it("rejects oversized web queries", async () => {
    const result = await executeAgentTool(
      "web_search",
      JSON.stringify({ query: "a".repeat(501) }),
      { mcpClient: createMcpMock(), webClient, mcpConnected: false }
    );
    expect(result.content).toContain("at most 500");
    expect(webClient.search).not.toHaveBeenCalled();
  });

  it("passes the AbortSignal through to MCP health checks and calls", async () => {
    const controller = new AbortController();
    const mcpClient = createMcpMock();
    await executeAgentTool("moocs_list_courses", "{}", {
      mcpClient,
      webClient,
      mcpConnected: true,
      signal: controller.signal,
    });

    expect(mcpClient.ping).toHaveBeenCalledWith(controller.signal);
    expect(mcpClient.callToolSafe).toHaveBeenCalledWith(
      "listCourses",
      undefined,
      undefined,
      controller.signal
    );
  });

  it("records an HTML page snapshot with its MOOCs citation", async () => {
    const url = "https://moocs.iniad.org/courses/2026/COS201/01/review";
    const result = await executeAgentTool("moocs_page_content", "{}", {
      mcpClient: createMcpMock({
        extractGoogleSlideText: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '{"error":"no_google_slides_iframe"}' }],
        }),
        getPageSnapshot: vi
          .fn()
          .mockResolvedValue(
            `- Page URL: ${url}\n- Page Title: 第1回 課題解説\n- Page Snapshot\nポインタの説明`
          ),
      }),
      webClient,
      mcpConnected: true,
    });

    expect(result.citations).toEqual([
      expect.objectContaining({
        title: "第1回 課題解説",
        url,
        location: "第1回 / 課題解説",
        sourceType: "moocs",
      }),
    ]);
    expect(result.materials).toEqual([
      expect.objectContaining({ url, content: expect.stringContaining("ポインタ") }),
    ]);
  });

  it("stops before tool execution when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const mcpClient = createMcpMock();

    await expect(
      executeAgentTool("moocs_list_courses", "{}", {
        mcpClient,
        webClient,
        mcpConnected: true,
        signal: controller.signal,
      })
    ).rejects.toThrow("キャンセル");
    expect(mcpClient.ping).not.toHaveBeenCalled();
  });
});
