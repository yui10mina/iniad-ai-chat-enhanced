import { describe, expect, it, vi } from "vitest";
import { McpClientError } from "../../src/main/services/mcp-client";
import type { McpConnectionResult, McpCredentials } from "../../src/main/services/mcp-connection";
import {
  testMcpCredentials,
  type McpCredentialTestDeps,
} from "../../src/main/services/mcp-credential-test";

const stored: McpCredentials = { moocsUsername: "saved-user", moocsPassword: "saved-pass" };
const connected: McpConnectionResult = { connected: true, state: { status: "connected" } };

function createDeps(overrides: Partial<McpCredentialTestDeps> = {}) {
  const calls: string[] = [];
  const deps = {
    getStoredCredentials: vi.fn(() => stored),
    disconnect: vi.fn(async () => {
      calls.push("disconnect");
    }),
    connect: vi.fn(async () => {
      calls.push("connect");
      return connected;
    }),
    verifyLogin: vi.fn(async () => {
      calls.push("verifyLogin");
    }),
    save: vi.fn(async () => {
      calls.push("save");
    }),
    restoreStoredConnection: vi.fn(() => {
      calls.push("restore");
    }),
    ...overrides,
  };
  return { deps, calls };
}

function authError(): McpClientError {
  return new McpClientError(
    "MCP_AUTH_FAILED",
    "MOOCs の認証に失敗しました。",
    "authentication",
    "設定画面で学籍番号とパスワードを再入力してください。",
    false
  );
}

describe("testMcpCredentials", () => {
  it("saves typed credentials only after the login is verified", async () => {
    const { deps, calls } = createDeps();
    const input = { moocsUsername: "new-user", moocsPassword: "new-pass" };

    await expect(testMcpCredentials(input, deps)).resolves.toEqual({ success: true });

    expect(calls).toEqual(["disconnect", "connect", "verifyLogin", "save"]);
    expect(deps.connect).toHaveBeenCalledWith(input);
    expect(deps.save).toHaveBeenCalledWith(input);
    expect(deps.restoreStoredConnection).not.toHaveBeenCalled();
  });

  it("does not save and restores the stored connection when the login fails", async () => {
    const { deps, calls } = createDeps({
      verifyLogin: vi.fn(async () => {
        throw authError();
      }),
    });

    const result = await testMcpCredentials({ moocsPassword: "wrong" }, deps);

    expect(result).toEqual({
      success: false,
      error: "MOOCs の認証に失敗しました。",
      guidance: "設定画面で学籍番号とパスワードを再入力してください。",
    });
    expect(deps.save).not.toHaveBeenCalled();
    expect(calls).toEqual(["disconnect", "connect", "restore"]);
  });

  it("does not verify, save, or report success when the connection fails", async () => {
    const { deps } = createDeps({
      connect: vi.fn(
        async (): Promise<McpConnectionResult> => ({
          connected: false,
          error: "接続できません",
          state: { status: "error" },
        })
      ),
    });

    const result = await testMcpCredentials({ moocsPassword: "new-pass" }, deps);

    expect(result).toMatchObject({ success: false, error: "接続できません" });
    expect(deps.verifyLogin).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.restoreStoredConnection).toHaveBeenCalledOnce();
  });

  it("combines a typed password with the stored username", async () => {
    const { deps } = createDeps();

    await testMcpCredentials({ moocsPassword: "new-pass" }, deps);

    expect(deps.connect).toHaveBeenCalledWith({
      moocsUsername: "saved-user",
      moocsPassword: "new-pass",
    });
    expect(deps.save).toHaveBeenCalledWith({ moocsPassword: "new-pass" });
  });

  it("reconnects to test stored credentials and does not save them", async () => {
    const { deps, calls } = createDeps();

    await expect(testMcpCredentials({}, deps)).resolves.toEqual({ success: true });

    // 既存の接続を再利用すると、ログイン済みのブラウザーでパスワードを検証せずに成功する。
    expect(calls).toEqual(["disconnect", "connect", "verifyLogin"]);
    expect(deps.connect).toHaveBeenCalledWith(stored);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("restores the connection when a stored-credential test fails", async () => {
    const { deps, calls } = createDeps({
      verifyLogin: vi.fn(async () => {
        throw authError();
      }),
    });

    await expect(testMcpCredentials({}, deps)).resolves.toMatchObject({ success: false });

    expect(calls).toEqual(["disconnect", "connect", "restore"]);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("does nothing when either credential is missing", async () => {
    const { deps } = createDeps({
      getStoredCredentials: vi.fn(() => ({ moocsUsername: "", moocsPassword: "" })),
    });

    const result = await testMcpCredentials({ moocsUsername: "new-user" }, deps);

    expect(result).toEqual({ success: false, error: "学籍番号とパスワードを入力してください" });
    expect(deps.disconnect).not.toHaveBeenCalled();
    expect(deps.connect).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("restores the stored connection when saving fails", async () => {
    const { deps } = createDeps({
      save: vi.fn(async () => {
        throw new Error("disk full: secret-value");
      }),
    });

    const result = await testMcpCredentials({ moocsPassword: "new-pass" }, deps);

    expect(result).toEqual({
      success: false,
      error: "ログインは確認できましたが、認証情報を保存できませんでした",
    });
    expect(deps.restoreStoredConnection).toHaveBeenCalledOnce();
  });

  it("does not expose raw text from an unclassified error", async () => {
    const { deps } = createDeps({
      verifyLogin: vi.fn(async () => {
        throw new Error("failed for secret-password");
      }),
    });

    const result = await testMcpCredentials({ moocsPassword: "new-pass" }, deps);

    expect(result).toEqual({
      success: false,
      error: "MOOCs へのログインを確認できませんでした",
    });
  });
});
