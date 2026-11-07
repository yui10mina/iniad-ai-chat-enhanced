import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  ping: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  clientClose: vi.fn(),
  transportClose: vi.fn(),
  transportOptions: [] as Array<Record<string, unknown>>,
  clientInstances: [] as Array<{ onclose?: () => void }>,
}));

vi.mock("@modelcontextprotocol/sdk/client/index", () => ({
  Client: class MockClient {
    onclose?: () => void;

    constructor() {
      sdkMocks.clientInstances.push(this);
    }

    connect(...args: unknown[]) {
      return sdkMocks.connect(...args);
    }

    ping(...args: unknown[]) {
      return sdkMocks.ping(...args);
    }

    listTools(...args: unknown[]) {
      return sdkMocks.listTools(...args);
    }

    callTool(...args: unknown[]) {
      return sdkMocks.callTool(...args);
    }

    request(request: { method: string }, ...args: unknown[]) {
      return request.method === "tools/list"
        ? sdkMocks.listTools(request, ...args)
        : sdkMocks.callTool(request, ...args);
    }

    close() {
      return sdkMocks.clientClose();
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio", () => ({
  StdioClientTransport: class MockTransport {
    constructor(options: Record<string, unknown>) {
      sdkMocks.transportOptions.push(options);
    }

    close() {
      return sdkMocks.transportClose();
    }
  },
}));

import {
  buildMcpChildEnvironment,
  McpClient,
  McpClientError,
  REQUIRED_MCP_TOOLS,
  validateMcpToolCall,
} from "../../src/main/services/mcp-client";

function availableTools() {
  return REQUIRED_MCP_TOOLS.map((name) => ({ name }));
}

describe("McpClient security boundary", () => {
  beforeEach(() => {
    sdkMocks.connect.mockReset().mockResolvedValue(undefined);
    sdkMocks.ping.mockReset().mockResolvedValue({});
    sdkMocks.listTools.mockReset().mockResolvedValue({ tools: availableTools() });
    sdkMocks.callTool.mockReset().mockResolvedValue({ content: [] });
    sdkMocks.clientClose.mockReset().mockResolvedValue(undefined);
    sdkMocks.transportClose.mockReset().mockResolvedValue(undefined);
    sdkMocks.transportOptions.length = 0;
    sdkMocks.clientInstances.length = 0;
  });

  it("passes only allowlisted environment variables plus MCP credentials", () => {
    const env = buildMcpChildEnvironment(
      {
        Path: "C:\\Windows\\System32",
        TEMP: "C:\\Temp",
        GH_TOKEN: "must-not-leak",
        AWS_SECRET_ACCESS_KEY: "must-not-leak-either",
        NODE_OPTIONS: "--require attacker.js",
      },
      "student",
      "secret-password"
    );

    expect(env).toEqual(
      expect.objectContaining({
        Path: "C:\\Windows\\System32",
        TEMP: "C:\\Temp",
        INIAD_USERNAME: "student",
        INIAD_PASSWORD: "secret-password",
      })
    );
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
  });

  it("uses a resolved absolute Node executable instead of resolving node from PATH", async () => {
    const client = new McpClient();
    await client.connect("student", "password");

    expect(sdkMocks.transportOptions[0]).toEqual(
      expect.objectContaining({
        command: process.execPath,
        stderr: "ignore",
      })
    );
    expect(sdkMocks.transportOptions[0].args).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/mcp-runtime-entry\.cjs$/),
        "--browser",
        "chromium",
        "--executable-path",
      ])
    );
  });

  it("allows only fixed tools with exact argument schemas", () => {
    expect(validateMcpToolCall("listCourses")).toEqual({
      name: "listCourses",
      arguments: undefined,
    });
    expect(
      validateMcpToolCall("browser_navigate", {
        url: "https://moocs.iniad.org/courses/2026/COS101/",
      })
    ).toEqual({
      name: "browser_navigate",
      arguments: { url: "https://moocs.iniad.org/courses/2026/COS101/" },
    });

    expect(() => validateMcpToolCall("submit_assignment")).toThrow("許可されていない");
    expect(() => validateMcpToolCall("listCourses", { extra: true })).toThrow("引数が不正");
    expect(() =>
      validateMcpToolCall("browser_navigate", {
        url: "https://moocs.iniad.org.evil.example/",
      })
    ).toThrow("MOOCs 以外");
    expect(() =>
      validateMcpToolCall("browser_navigate", {
        url: "https://user:pass@moocs.iniad.org/",
      })
    ).toThrow("MOOCs 以外");
    expect(() =>
      validateMcpToolCall("browser_navigate", {
        url: "https://moocs.iniad.org:444/",
      })
    ).toThrow("MOOCs 以外");
  });

  it("becomes connected only after initialization and required tool discovery", async () => {
    let resolveTools!: (value: { tools: Array<{ name: string }> }) => void;
    sdkMocks.listTools.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTools = resolve;
        })
    );
    const client = new McpClient();

    const pending = client.connect("student", "password");
    await vi.waitFor(() => expect(sdkMocks.connect).toHaveBeenCalledTimes(1));
    expect(client.getStatus()).toBe("connecting");

    resolveTools({ tools: availableTools() });
    await pending;
    expect(client.getStatus()).toBe("connected");
    expect(sdkMocks.listTools).toHaveBeenCalledTimes(1);
  });

  it("rejects readiness when a required tool is missing", async () => {
    sdkMocks.listTools.mockResolvedValue({ tools: [{ name: "listCourses" }] });
    const client = new McpClient();

    await expect(client.connect("student", "password")).rejects.toEqual(
      expect.objectContaining<McpClientError>({
        code: "MCP_TOOLS_UNAVAILABLE",
        kind: "configuration",
        retryable: false,
      })
    );
    expect(client.getStatus()).toBe("error");
    expect(sdkMocks.clientClose).toHaveBeenCalled();
  });

  it("uses MCP ping for health checks without listing all tools again", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    const controller = new AbortController();

    await expect(client.ping(controller.signal)).resolves.toBe(true);

    expect(sdkMocks.ping).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: 5_000,
        maxTotalTimeout: 5_000,
        signal: controller.signal,
      })
    );
    expect(sdkMocks.listTools).toHaveBeenCalledTimes(1);
  });

  it("deduplicates direct connect calls on the same client", async () => {
    let finishInitialize!: () => void;
    sdkMocks.connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishInitialize = resolve;
        })
    );
    const client = new McpClient();

    const first = client.connect("student", "password");
    const second = client.connect("student", "password");
    await vi.waitFor(() => expect(sdkMocks.connect).toHaveBeenCalledTimes(1));
    expect(sdkMocks.connect).toHaveBeenCalledTimes(1);

    finishInitialize();
    await Promise.all([first, second]);
    expect(sdkMocks.connect).toHaveBeenCalledTimes(1);
    expect(sdkMocks.listTools).toHaveBeenCalledTimes(1);
  });

  it("forwards a bounded timeout and AbortSignal to allowed tool calls", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    const controller = new AbortController();

    await client.callToolSafe("listCourses", undefined, 12_345, controller.signal);

    expect(sdkMocks.callTool).toHaveBeenCalledWith(
      { method: "tools/call", params: { name: "listCourses", arguments: {} } },
      expect.anything(),
      expect.objectContaining({
        timeout: 12_345,
        maxTotalTimeout: 12_345,
        signal: controller.signal,
      })
    );
  });

  it("does not invoke MCP for a pre-cancelled request", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.callToolSafe("listCourses", undefined, 45_000, controller.signal)
    ).rejects.toEqual(expect.objectContaining({ code: "CHAT_CANCELLED" }));
    expect(sdkMocks.callTool).not.toHaveBeenCalled();
  });

  it("does not treat an arbitrary error message containing aborted as user cancellation", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    sdkMocks.callTool.mockRejectedValueOnce(new Error("remote operation aborted unexpectedly"));

    await expect(client.callToolSafe("listCourses")).rejects.toEqual(
      expect.objectContaining<McpClientError>({
        code: "MCP_CONNECTION_FAILED",
        kind: "unknown",
      })
    );
    expect(client.getStatus()).toBe("connected");
  });

  it("marks transport failures disconnected and notifies Main with sanitized metadata", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    const listener = vi.fn();
    client.onConnectionIssue(listener);
    sdkMocks.callTool.mockRejectedValueOnce(new Error("Connection closed: private details"));

    await expect(client.callToolSafe("listCourses")).rejects.toEqual(
      expect.objectContaining<McpClientError>({
        code: "MCP_CONNECTION_FAILED",
        kind: "transient",
        retryable: true,
      })
    );
    expect(client.getStatus()).toBe("disconnected");
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "MCP_CONNECTION_FAILED",
        retryable: true,
        guidance: expect.any(String),
      })
    );
    expect(listener.mock.calls[0][0].message).not.toContain("private details");
  });

  it("notifies Main immediately when the MCP transport closes", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    const listener = vi.fn();
    client.onConnectionIssue(listener);

    sdkMocks.clientInstances[0].onclose?.();

    expect(client.getStatus()).toBe("disconnected");
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ code: "MCP_CONNECTION_FAILED", retryable: true })
    );
  });

  it("marks authentication tool errors as error and notifies Main", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    const listener = vi.fn();
    client.onConnectionIssue(listener);
    sdkMocks.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "Login failed: unauthorized for student@example.com" }],
    });

    await expect(client.loginToMoocs()).rejects.toEqual(
      expect.objectContaining<McpClientError>({
        code: "MCP_AUTH_FAILED",
        retryable: false,
      })
    );

    expect(client.getStatus()).toBe("error");
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "MCP_AUTH_FAILED",
        retryable: false,
      })
    );
    expect(listener.mock.calls[0][0].message).not.toContain("student@example.com");
  });

  it("verifies the login only when at least one course is returned", async () => {
    const client = new McpClient();
    await client.connect("student", "password");

    sdkMocks.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ courses: [{ id: "COS201" }] }) }],
    });
    await expect(client.verifyMoocsLogin()).resolves.toBeUndefined();

    // ログイン画面を経由できなかった場合、ツールはエラーではなく空の一覧を返す。
    sdkMocks.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ courses: [] }) }],
    });
    await expect(client.verifyMoocsLogin()).rejects.toEqual(
      expect.objectContaining<Partial<McpClientError>>({
        code: "MCP_AUTH_FAILED",
        retryable: false,
      })
    );

    sdkMocks.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "Login failed: Timeout 5000ms exceeded" }],
    });
    await expect(client.verifyMoocsLogin()).rejects.toEqual(
      expect.objectContaining<Partial<McpClientError>>({ code: "MCP_AUTH_FAILED" })
    );
  });

  it("treats a network failure during login as transient, not as bad credentials", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    const listener = vi.fn();
    client.onConnectionIssue(listener);
    sdkMocks.callTool.mockResolvedValueOnce({
      isError: true,
      content: [
        { type: "text", text: "Login failed: page.goto: net::ERR_INTERNET_DISCONNECTED at x" },
      ],
    });

    await expect(client.verifyMoocsLogin()).rejects.toEqual(
      expect.objectContaining<Partial<McpClientError>>({
        code: "MCP_CONNECTION_FAILED",
        kind: "transient",
        retryable: true,
      })
    );
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ retryable: true }));
  });

  it("keeps a wrong password, shown as a redirect timeout, as an authentication failure", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    sdkMocks.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "Login failed: page.waitForURL: Timeout 5000ms exceeded" }],
    });

    await expect(client.verifyMoocsLogin()).rejects.toEqual(
      expect.objectContaining<Partial<McpClientError>>({
        code: "MCP_AUTH_FAILED",
        retryable: false,
      })
    );
  });

  it("does not treat a navigation error outside login as a lost connection", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    sdkMocks.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "page.goto: net::ERR_ABORTED at https://moocs.iniad.org/x" }],
    });

    await expect(client.navigateTo("https://moocs.iniad.org/x")).rejects.toEqual(
      expect.objectContaining<Partial<McpClientError>>({ kind: "unknown" })
    );
    expect(client.getStatus()).toBe("connected");
  });

  it("does not expose raw text from an unclassified MCP tool error", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    sdkMocks.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "private details for student@example.com" }],
    });

    await expect(client.loginToMoocs()).rejects.toEqual(
      expect.objectContaining<McpClientError>({
        message: "MCP ツールの実行に失敗しました。",
        kind: "unknown",
      })
    );
    expect(client.getStatus()).toBe("connected");
  });

  it("does not log credentials, tool arguments, or raw errors", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = new McpClient();

    await client.connect("student-private", "password-private");
    await client.navigateTo("https://moocs.iniad.org/private-course");

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });
});
