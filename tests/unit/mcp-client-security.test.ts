import fs from "fs";
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

const actualRealpathSync = fs.realpathSync;

/**
 * Playwright のブラウザーが入っていない環境（CI）でも動くよう、ブラウザーのパスだけ実在を問わない。
 * 起動スクリプトや MCP CLI のパスは実物で解決し、欠けていればテストを失敗させる。
 */
function realpathSyncIgnoringBrowser(target: fs.PathLike, ...rest: unknown[]): unknown {
  if (/[\\/]chromium[-_][^\\/]*[\\/]/.test(String(target))) return String(target);
  return (actualRealpathSync as (...args: unknown[]) => unknown)(target, ...rest);
}

function resetSdkMocks(): void {
  vi.spyOn(fs, "realpathSync").mockImplementation(
    realpathSyncIgnoringBrowser as typeof fs.realpathSync
  );
  sdkMocks.connect.mockReset().mockResolvedValue(undefined);
  sdkMocks.ping.mockReset().mockResolvedValue({});
  sdkMocks.listTools.mockReset().mockResolvedValue({ tools: availableTools() });
  sdkMocks.callTool.mockReset().mockResolvedValue({ content: [] });
  sdkMocks.clientClose.mockReset().mockResolvedValue(undefined);
  sdkMocks.transportClose.mockReset().mockResolvedValue(undefined);
  sdkMocks.transportOptions.length = 0;
  sdkMocks.clientInstances.length = 0;
}

describe("McpClient security boundary", () => {
  beforeEach(resetSdkMocks);

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
      expect.objectContaining<Partial<McpClientError>>({
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
      expect.objectContaining<Partial<McpClientError>>({
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
      expect.objectContaining<Partial<McpClientError>>({
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
      expect.objectContaining<Partial<McpClientError>>({
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
      expect.objectContaining<Partial<McpClientError>>({
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

describe("McpClient MOOCs login reuse", () => {
  beforeEach(() => {
    resetSdkMocks();
    vi.useRealTimers();
  });

  const LOGIN_TOOL = "loginToIniadMoocsWithIniadAccount";
  const coursesResult = (count = 1) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          courses: Array.from({ length: count }, (_, i) => ({ id: `C${i}`, title: `Course ${i}` })),
        }),
      },
    ],
  });
  const calledToolNames = () =>
    sdkMocks.callTool.mock.calls.map(
      (call) => (call[0] as { params: { name: string } }).params.name
    );
  const loginCount = () => calledToolNames().filter((name) => name === LOGIN_TOOL).length;

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("reuses a successful login instead of logging in again", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    sdkMocks.callTool.mockResolvedValue(coursesResult());

    const first = await client.ensureMoocsLogin();
    const second = await client.ensureMoocsLogin();

    expect(loginCount()).toBe(1);
    expect(second).toBe(first);
  });

  it("shares one login between callers that arrive while it is running", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    const login = deferred<unknown>();
    sdkMocks.callTool.mockReturnValueOnce(login.promise);

    const a = client.ensureMoocsLogin();
    const b = client.loginToMoocs();
    login.resolve(coursesResult());

    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
    expect(loginCount()).toBe(1);
  });

  it("does not remember a login that returned no courses", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    sdkMocks.callTool.mockResolvedValueOnce(coursesResult(0));
    sdkMocks.callTool.mockResolvedValueOnce(coursesResult(1));

    await client.ensureMoocsLogin();
    await client.ensureMoocsLogin();

    expect(loginCount()).toBe(2);
  });

  it("logs in again once the remembered login is 20 minutes old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const client = new McpClient();
    await client.connect("student", "password");
    sdkMocks.callTool.mockResolvedValue(coursesResult());

    await client.ensureMoocsLogin();
    vi.setSystemTime(Date.now() + 19 * 60_000);
    await client.ensureMoocsLogin();
    expect(loginCount()).toBe(1);

    vi.setSystemTime(Date.now() + 2 * 60_000);
    await client.ensureMoocsLogin();
    expect(loginCount()).toBe(2);
  });

  it("forgets the login when the connection is closed and reopened", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    sdkMocks.callTool.mockResolvedValue(coursesResult());
    await client.ensureMoocsLogin();

    await client.disconnect();
    await client.connect("student", "password");
    await client.ensureMoocsLogin();

    expect(loginCount()).toBe(2);
  });

  it("forgets the login after an authentication failure", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    sdkMocks.callTool.mockResolvedValueOnce(coursesResult());
    await client.ensureMoocsLogin();

    sdkMocks.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "Login failed: unauthorized" }],
    });
    await expect(client.loginToMoocs()).rejects.toEqual(
      expect.objectContaining<Partial<McpClientError>>({ code: "MCP_AUTH_FAILED" })
    );
    // 覚えていた結果を返さず、接続されていないことを伝える。
    await expect(client.ensureMoocsLogin()).rejects.toEqual(
      expect.objectContaining<Partial<McpClientError>>({ code: "MCP_CONNECTION_FAILED" })
    );

    await client.connect("student", "password");
    sdkMocks.callTool.mockResolvedValueOnce(coursesResult());
    await client.ensureMoocsLogin();
    expect(loginCount()).toBe(3);
  });

  it("still performs a real login for the settings connection test", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    sdkMocks.callTool.mockResolvedValue(coursesResult());
    await client.ensureMoocsLogin();

    await client.verifyMoocsLogin();

    expect(loginCount()).toBe(2);
  });

  it("makes other tools wait until a running login has finished", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    const login = deferred<unknown>();
    sdkMocks.callTool.mockReturnValueOnce(login.promise);
    sdkMocks.callTool.mockResolvedValue({ content: [] });

    const loginDone = client.ensureMoocsLogin();
    const navigateDone = client.navigateTo("https://moocs.iniad.org/courses/2026/COS201");
    await Promise.resolve();
    await Promise.resolve();
    expect(calledToolNames()).toEqual([LOGIN_TOOL]);

    login.resolve(coursesResult());
    await Promise.all([loginDone, navigateDone]);
    expect(calledToolNames()).toEqual([LOGIN_TOOL, "browser_navigate"]);
  });

  it("lets a cancelled caller stop waiting without stopping the shared login", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    const login = deferred<unknown>();
    sdkMocks.callTool.mockReturnValueOnce(login.promise);
    const controller = new AbortController();

    const background = client.ensureMoocsLogin();
    const cancelled = client.loginToMoocs(controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toEqual(
      expect.objectContaining<Partial<McpClientError>>({ code: "CHAT_CANCELLED" })
    );

    login.resolve(coursesResult());
    await background;
    await client.ensureMoocsLogin();
    expect(loginCount()).toBe(1);
  });

  it("does not share a login that is still running on a closed connection", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    const staleLogin = deferred<unknown>();
    sdkMocks.callTool.mockReturnValueOnce(staleLogin.promise);

    const background = client.ensureMoocsLogin();
    await client.disconnect();
    await client.connect("student", "password");

    // 古いログインがまだ終わっていなくても、新しい接続では入り直す。
    sdkMocks.callTool.mockResolvedValueOnce(coursesResult());
    const fresh = client.loginToMoocs();
    staleLogin.reject(new Error("Connection closed"));

    await expect(fresh).resolves.toEqual(coursesResult());
    await expect(background).rejects.toBeDefined();
    expect(loginCount()).toBe(2);
  });

  it("does not let a login from a closed connection break the new connection", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    const staleLogin = deferred<unknown>();
    sdkMocks.callTool.mockReturnValueOnce(staleLogin.promise);
    const listener = vi.fn();
    client.onConnectionIssue(listener);

    const background = client.ensureMoocsLogin();
    await client.disconnect();
    await client.connect("student", "password");
    const closesBefore = sdkMocks.clientClose.mock.calls.length;

    // 古い接続のログインは、client を閉じたことで失敗する。
    staleLogin.reject(new Error("Connection closed"));
    await expect(background).rejects.toBeDefined();

    expect(client.getStatus()).toBe("connected");
    expect(sdkMocks.clientClose.mock.calls.length).toBe(closesBefore);
    expect(listener).not.toHaveBeenCalled();

    // 新しい接続のログインは、古いログインを共有せずに行う。
    sdkMocks.callTool.mockResolvedValueOnce(coursesResult());
    await expect(client.loginToMoocs()).resolves.toEqual(coursesResult());
  });

  it("forgets the remembered login when a later login returns no courses", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    sdkMocks.callTool.mockResolvedValueOnce(coursesResult(1));
    await client.ensureMoocsLogin();

    sdkMocks.callTool.mockResolvedValueOnce(coursesResult(0));
    await client.loginToMoocs();

    sdkMocks.callTool.mockResolvedValueOnce(coursesResult(1));
    await client.ensureMoocsLogin();
    expect(loginCount()).toBe(3);
  });

  it("forgets the remembered login when a later login fails without closing the connection", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    sdkMocks.callTool.mockResolvedValueOnce(coursesResult(1));
    await client.ensureMoocsLogin();

    // 分類できないエラーでは接続を閉じないが、前のログインは信用しない。
    sdkMocks.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "something unexpected" }],
    });
    await expect(client.loginToMoocs()).rejects.toEqual(
      expect.objectContaining<Partial<McpClientError>>({ kind: "unknown" })
    );
    expect(client.getStatus()).toBe("connected");

    sdkMocks.callTool.mockResolvedValueOnce(coursesResult(1));
    await client.ensureMoocsLogin();
    expect(loginCount()).toBe(3);
  });

  it("does not remember a login from a closed connection that succeeds late", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    const staleLogin = deferred<unknown>();
    sdkMocks.callTool.mockReturnValueOnce(staleLogin.promise);

    const background = client.ensureMoocsLogin();
    await client.disconnect();
    await client.connect("other-student", "other-password");
    staleLogin.resolve(coursesResult(1));
    await background;

    sdkMocks.callTool.mockResolvedValueOnce(coursesResult(2));
    await expect(client.ensureMoocsLogin()).resolves.toEqual(coursesResult(2));
    expect(loginCount()).toBe(2);
  });

  it("remembers a successful background login for the next question", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    sdkMocks.callTool.mockResolvedValue(coursesResult());

    await expect(client.prewarmMoocsLogin()).resolves.toBe(true);
    await client.ensureMoocsLogin();

    expect(loginCount()).toBe(1);
  });

  it.each([
    [
      "an unreachable MOOCs site",
      "Login failed: page.goto: net::ERR_NAME_NOT_RESOLVED at https://moocs.iniad.org/",
    ],
    ["a slow SSO redirect", "Login failed: page.waitForURL: Timeout 5000ms exceeded."],
  ])("keeps the connection as it is when a background login fails on %s", async (_case, text) => {
    const client = new McpClient();
    await client.connect("student", "password");
    const listener = vi.fn();
    client.onConnectionIssue(listener);
    const closesBefore = sdkMocks.clientClose.mock.calls.length;
    sdkMocks.callTool.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text }] });

    await expect(client.prewarmMoocsLogin()).resolves.toBe(false);

    expect(client.getStatus()).toBe("connected");
    expect(listener).not.toHaveBeenCalled();
    expect(sdkMocks.clientClose.mock.calls.length).toBe(closesBefore);
  });

  it("waits two minutes before trying a failed background login again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const client = new McpClient();
    await client.connect("student", "password");
    sdkMocks.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "Login failed: page.goto: net::ERR_INTERNET_DISCONNECTED" }],
    });
    await client.prewarmMoocsLogin();

    vi.setSystemTime(Date.now() + 60_000);
    await expect(client.prewarmMoocsLogin()).resolves.toBe(false);
    expect(loginCount()).toBe(1);

    vi.setSystemTime(Date.now() + 61_000);
    sdkMocks.callTool.mockResolvedValueOnce(coursesResult());
    await expect(client.prewarmMoocsLogin()).resolves.toBe(true);
    expect(loginCount()).toBe(2);
  });

  it("retries a failed background login for the question and reports the real error", async () => {
    const client = new McpClient();
    await client.connect("student", "password");
    const listener = vi.fn();
    client.onConnectionIssue(listener);
    const backgroundLogin = deferred<unknown>();
    sdkMocks.callTool.mockReturnValueOnce(backgroundLogin.promise);
    sdkMocks.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "Login failed: unauthorized" }],
    });

    const background = client.prewarmMoocsLogin();
    const question = client.ensureMoocsLogin();
    backgroundLogin.resolve({
      isError: true,
      content: [{ type: "text", text: "Login failed: unauthorized" }],
    });

    await expect(background).resolves.toBe(false);
    await expect(question).rejects.toEqual(
      expect.objectContaining<Partial<McpClientError>>({ code: "MCP_AUTH_FAILED" })
    );
    expect(loginCount()).toBe(2);
    expect(client.getStatus()).toBe("error");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("McpClient slide extraction outcomes", () => {
  beforeEach(resetSdkMocks);

  const MOOCS_URL = "https://moocs.iniad.org/courses/2099/TEST101/vod01/01";

  function extractError(payload: Record<string, unknown>) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
  }

  async function connected() {
    const client = new McpClient();
    await client.connect("student", "password");
    const listener = vi.fn();
    client.onConnectionIssue(listener);
    return { client, listener };
  }

  it.each([
    "no_google_slides_iframe",
    "iframe_src_missing",
    "presentation_id_not_found",
    "google_login_required",
    "empty_slide_text",
  ])("returns %s as a result instead of throwing, and keeps the connection", async (error) => {
    const { client, listener } = await connected();
    sdkMocks.callTool.mockResolvedValueOnce(extractError({ error, moocsUrl: MOOCS_URL }));

    await expect(client.extractGoogleSlideText()).resolves.toEqual({
      content: [{ type: "text", text: JSON.stringify({ error, moocsUrl: MOOCS_URL }) }],
    });

    expect(client.getStatus()).toBe("connected");
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps only the error kind and the MOOCs URL from the tool's result", async () => {
    const { client } = await connected();
    sdkMocks.callTool.mockResolvedValueOnce(
      extractError({
        error: "empty_slide_text",
        moocsUrl: MOOCS_URL,
        presentationId: "secret-presentation-id",
        pubUrl: "https://docs.google.com/presentation/d/secret-presentation-id/pub",
        hint: "raw hint text",
        slideCount: 0,
        charCount: 0,
      })
    );

    const result = await client.extractGoogleSlideText();

    expect(JSON.stringify(result)).toBe(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "empty_slide_text", moocsUrl: MOOCS_URL }),
          },
        ],
      })
    );
  });

  it.each([
    "https://moocs.iniad.org.evil.example/courses/2099/TEST101/01/01",
    "http://moocs.iniad.org/courses/2099/TEST101/01/01",
    "https://user:pass@moocs.iniad.org/courses/2099/TEST101/01/01",
    "not a url",
  ])("drops a URL that is not a MOOCs page (%s)", async (moocsUrl) => {
    const { client } = await connected();
    sdkMocks.callTool.mockResolvedValueOnce(extractError({ error: "empty_slide_text", moocsUrl }));

    await expect(client.extractGoogleSlideText()).resolves.toEqual({
      content: [{ type: "text", text: JSON.stringify({ error: "empty_slide_text" }) }],
    });
  });

  it("still throws the generic failure for an error kind it does not know", async () => {
    const { client } = await connected();
    sdkMocks.callTool.mockResolvedValueOnce(
      extractError({ error: "something_new", moocsUrl: MOOCS_URL, detail: "secret-detail" })
    );

    const error = await client.extractGoogleSlideText().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpClientError);
    expect((error as McpClientError).message).toBe("MCP ツールの実行に失敗しました。");
    expect((error as McpClientError).message).not.toContain("secret-detail");
  });

  it("still throws for an error result that is not JSON", async () => {
    const { client } = await connected();
    sdkMocks.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "extractGoogleSlideText failed: page crashed" }],
    });

    await expect(client.extractGoogleSlideText()).rejects.toBeInstanceOf(McpClientError);
  });

  it("does not let another tool pass an error through by using the same wording", async () => {
    const { client } = await connected();
    sdkMocks.callTool.mockResolvedValueOnce(
      extractError({ error: "empty_slide_text", moocsUrl: MOOCS_URL })
    );

    await expect(client.callToolSafe("listSlideLinks")).rejects.toBeInstanceOf(McpClientError);
  });

  it("does not rewrite a result that is not marked as an error", async () => {
    const { client } = await connected();
    const unmarked = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "empty_slide_text", moocsUrl: MOOCS_URL, charCount: 0 }),
        },
      ],
    };
    sdkMocks.callTool.mockResolvedValueOnce(unmarked);

    await expect(client.extractGoogleSlideText()).resolves.toEqual(unmarked);
  });

  it("leaves a successful extraction untouched", async () => {
    const { client } = await connected();
    const success = {
      content: [{ type: "text", text: JSON.stringify({ moocsUrl: MOOCS_URL, text: "本文" }) }],
    };
    sdkMocks.callTool.mockResolvedValueOnce(success);

    await expect(client.extractGoogleSlideText()).resolves.toEqual(success);
  });
});
