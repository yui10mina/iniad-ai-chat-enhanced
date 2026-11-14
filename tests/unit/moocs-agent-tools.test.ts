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

  describe("outcome", () => {
    const run = (toolName: string, argsJson: string, mcpClient: McpClient = createMcpMock()) =>
      executeAgentTool(toolName, argsJson, { mcpClient, webClient, mcpConnected: true });

    it("marks a successful MCP result as ok", async () => {
      const result = await run("moocs_list_courses", "{}");

      expect(result.outcome).toEqual({ ok: true, code: "ok" });
    });

    it("marks a successful navigation as ok", async () => {
      const result = await run("moocs_navigate", '{"url":"https://moocs.iniad.org/courses"}');

      expect(result.outcome).toEqual({ ok: true, code: "ok" });
    });

    it.each<{ name: string; toolName: string; argsJson: string }>([
      { name: "arguments that are not JSON", toolName: "moocs_navigate", argsJson: '{"url":' },
      { name: "arguments that are not an object", toolName: "moocs_navigate", argsJson: "[]" },
      { name: "an unexpected argument", toolName: "moocs_list_courses", argsJson: '{"a":1}' },
      {
        name: "a URL outside MOOCs",
        toolName: "moocs_navigate",
        argsJson: '{"url":"https://moocs.iniad.org.evil.example/"}',
      },
      {
        name: "a slide URL outside MOOCs",
        toolName: "moocs_read_slide",
        argsJson: '{"url":"https://example.com/slide"}',
      },
    ])("marks $name as invalid_arguments", async ({ toolName, argsJson }) => {
      const mcpClient = createMcpMock();

      const result = await run(toolName, argsJson, mcpClient);

      expect(result.outcome).toEqual({ ok: false, code: "invalid_arguments" });
      expect(mcpClient.navigateTo).not.toHaveBeenCalled();
      expect(mcpClient.callToolSafe).not.toHaveBeenCalled();
    });

    it("tells an unknown tool from a blocked one", async () => {
      expect((await run("moocs_delete_everything", "{}")).outcome).toEqual({
        ok: false,
        code: "unknown_tool",
      });
      expect((await run("submit_assignment", "{}")).outcome).toEqual({
        ok: false,
        code: "blocked_tool",
      });
    });

    it("tells a missing MCP connection from a lost one", async () => {
      const notConnected = createMcpMock({ getStatus: vi.fn().mockReturnValue("disconnected") });
      const lost = createMcpMock({ ping: vi.fn().mockResolvedValue(false) });

      expect((await run("moocs_list_courses", "{}", notConnected)).outcome).toEqual({
        ok: false,
        code: "mcp_not_connected",
      });
      expect((await run("moocs_list_courses", "{}", lost)).outcome).toEqual({
        ok: false,
        code: "mcp_connection_lost",
      });
    });

    it("marks an MCP error result as mcp_error without putting its text in the code", async () => {
      const mcpClient = createMcpMock({
        callToolSafe: vi.fn().mockResolvedValue({
          isError: true,
          content: [{ type: "text", text: "session expired: secret-detail" }],
        }),
      });

      const result = await run("moocs_list_courses", "{}", mcpClient);

      expect(result.outcome).toEqual({ ok: false, code: "mcp_error" });
      expect(result.content).toContain("session expired");
    });

    it("marks a thrown error as exception without putting its message in the code", async () => {
      const mcpClient = createMcpMock({
        callToolSafe: vi.fn().mockRejectedValue(new Error("boom: secret-detail")),
      });

      const result = await run("moocs_list_courses", "{}", mcpClient);

      expect(result.outcome).toEqual({ ok: false, code: "exception" });
      expect(result.content).toBe("Tool error: boom: secret-detail");
    });

    it("marks an empty page snapshot as content_unavailable", async () => {
      const mcpClient = createMcpMock({ getPageSnapshot: vi.fn().mockResolvedValue("") });

      const result = await run("moocs_page_content", "{}", mcpClient);

      expect(result.outcome).toEqual({ ok: false, code: "content_unavailable" });
    });

    it("tells a failed web search from one with no results", async () => {
      const search = vi
        .fn()
        .mockResolvedValueOnce({ success: false, results: [], error: "timeout" })
        .mockResolvedValueOnce({ success: true, results: [] })
        .mockResolvedValueOnce({
          success: true,
          results: [{ title: "Web", url: "https://example.com", snippet: "info", source: "web" }],
        });
      const searchWith = () =>
        executeAgentTool("web_search", '{"query":"TCP"}', {
          mcpClient: createMcpMock(),
          webClient: { search },
          mcpConnected: true,
        });

      expect((await searchWith()).outcome).toEqual({ ok: false, code: "web_search_failed" });
      expect((await searchWith()).outcome).toEqual({ ok: true, code: "no_results" });
      expect((await searchWith()).outcome).toEqual({ ok: true, code: "ok" });
    });
  });

  describe("Google login state", () => {
    const SLIDE = "https://moocs.iniad.org/courses/2026/COS201/01/01";
    const slideText = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            moocsUrl: SLIDE,
            text: "C言語は組込みシステムで標準的な言語であり、ポインタによってメモリを直接扱える。",
          }),
        },
      ],
    };

    it("logs in to Google before the first slide read of the question, once", async () => {
      const mcpClient = createMcpMock({
        loginToGoogle: vi.fn().mockResolvedValue(undefined),
        extractGoogleSlideText: vi.fn().mockResolvedValue(slideText),
      });
      const ctx = {
        mcpClient,
        webClient,
        mcpConnected: true,
        googleLoginState: { attempted: false },
      };

      await executeAgentTool("moocs_read_slide", JSON.stringify({ url: SLIDE }), ctx);
      await executeAgentTool(
        "moocs_read_slide",
        JSON.stringify({ url: SLIDE.replace("/01/01", "/01/02") }),
        ctx
      );

      expect(mcpClient.loginToGoogle).toHaveBeenCalledTimes(1);
    });

    it("does not log in again before a read when the model already called moocs_google_login", async () => {
      const mcpClient = createMcpMock({
        loginToGoogle: vi.fn().mockResolvedValue(undefined),
        extractGoogleSlideText: vi.fn().mockResolvedValue(slideText),
      });
      const ctx = {
        mcpClient,
        webClient,
        mcpConnected: true,
        googleLoginState: { attempted: false },
      };

      await executeAgentTool("moocs_google_login", "{}", ctx);
      await executeAgentTool("moocs_read_slide", JSON.stringify({ url: SLIDE }), ctx);

      expect(mcpClient.callToolSafe).toHaveBeenCalledWith(
        "loginToGoogleWithIniadAccount",
        undefined,
        90_000,
        undefined
      );
      expect(mcpClient.loginToGoogle).not.toHaveBeenCalled();
    });
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
