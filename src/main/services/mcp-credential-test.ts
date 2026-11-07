import type { ConnectionTestResult, McpCredentialTestInput } from "../../shared/types/settings";
import { McpClientError } from "./mcp-client";
import type { McpConnectionResult, McpCredentials } from "./mcp-connection";

export interface McpCredentialTestDeps {
  getStoredCredentials: () => McpCredentials;
  /** 既存の接続と自動再接続を止める。 */
  disconnect: () => Promise<void>;
  connect: (credentials: McpCredentials) => Promise<McpConnectionResult>;
  /** MOOCs へのログインを確認する。失敗時は例外を投げる。 */
  verifyLogin: () => Promise<void>;
  save: (input: McpCredentialTestInput) => Promise<void>;
  /** テストに失敗したあと、保存済みの値での接続へ戻す。完了は待たない。 */
  restoreStoredConnection: () => void;
}

/**
 * MOOCs の認証情報をテストし、ログインを確認できた入力値だけを保存する。
 * 失敗しても保存済みの値は変更しない。
 *
 * 保存済みの値のテストでも必ず接続し直す。既存の接続を再利用すると、別の認証情報の成功を
 * 入力値の成功と誤認したり、ログイン済みのブラウザーでパスワードを検証せずに成功したりする。
 */
export async function testMcpCredentials(
  input: McpCredentialTestInput,
  deps: McpCredentialTestDeps
): Promise<ConnectionTestResult> {
  const stored = deps.getStoredCredentials();
  const credentials: McpCredentials = {
    moocsUsername: input.moocsUsername ?? stored.moocsUsername,
    moocsPassword: input.moocsPassword ?? stored.moocsPassword,
  };
  if (!credentials.moocsUsername.trim() || !credentials.moocsPassword) {
    return { success: false, error: "学籍番号とパスワードを入力してください" };
  }

  await deps.disconnect();

  const failure = await connectAndVerify(credentials, deps);
  if (failure) {
    deps.restoreStoredConnection();
    return failure;
  }

  const hasInput = input.moocsUsername !== undefined || input.moocsPassword !== undefined;
  if (!hasInput) return { success: true };

  try {
    await deps.save(input);
    return { success: true };
  } catch {
    deps.restoreStoredConnection();
    return {
      success: false,
      error: "ログインは確認できましたが、認証情報を保存できませんでした",
    };
  }
}

async function connectAndVerify(
  credentials: McpCredentials,
  deps: McpCredentialTestDeps
): Promise<ConnectionTestResult | null> {
  try {
    const connection = await deps.connect(credentials);
    if (!connection.connected) {
      return {
        success: false,
        error: connection.state.error?.message ?? connection.error ?? "MCP接続に失敗しました",
        guidance: connection.state.error?.guidance,
      };
    }
    await deps.verifyLogin();
    return null;
  } catch (error) {
    // 分類前のエラー文には資格情報や個人情報が混ざりうるので、画面へ渡さない。
    if (error instanceof McpClientError) {
      return { success: false, error: error.message, guidance: error.guidance };
    }
    return { success: false, error: "MOOCs へのログインを確認できませんでした" };
  }
}
