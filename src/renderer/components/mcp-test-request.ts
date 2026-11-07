import type {
  AppSettings,
  McpCredentialTestInput,
  PublicAppSettings,
} from "../../shared/types/settings";

export interface McpTestRequest {
  /** 学籍番号とパスワードが揃っていて、テストできる状態か */
  canTest: boolean;
  /** Main へ渡す入力値。空なら保存済みの値でテストする */
  input: McpCredentialTestInput;
}

export function isMcpCredentialField(field: keyof AppSettings): boolean {
  return field === "moocsUsername" || field === "moocsPassword";
}

/**
 * 「保存」で送る項目を決める。
 *
 * 空の認証情報欄は「変更なし」を表すので送らない。空白だけのパスワードで保存済みの値を
 * 上書きしないためでもある。skipCredentials は接続テストで失敗した値を保存しないために使う。
 */
export function buildSavePayload(
  settings: PublicAppSettings,
  editedFields: ReadonlySet<keyof AppSettings>,
  skipCredentials: boolean
): Partial<AppSettings> {
  const payload: Partial<AppSettings> = {};
  for (const field of editedFields) {
    if (isMcpCredentialField(field)) {
      if (skipCredentials || !settings[field].trim()) continue;
    }
    payload[field] = settings[field];
  }
  return payload;
}

/** 画面の入力状態から、MOOCs 接続テストの内容を決める。 */
export function buildMcpTestRequest(
  settings: PublicAppSettings,
  editedFields: ReadonlySet<keyof AppSettings>
): McpTestRequest {
  const username = settings.moocsUsername.trim();
  // 空のパスワード欄は「変更なし」を表す（保存時の扱いと同じ）。
  const typedPassword =
    editedFields.has("moocsPassword") && settings.moocsPassword.trim().length > 0
      ? settings.moocsPassword
      : "";

  const input: McpCredentialTestInput = {};
  if (editedFields.has("moocsUsername") && username) input.moocsUsername = username;
  if (typedPassword) input.moocsPassword = typedPassword;

  return {
    canTest: username.length > 0 && (typedPassword.length > 0 || settings.hasMoocsCredentials),
    input,
  };
}
