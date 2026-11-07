import { AppError } from "../shared/types/errors";
import {
  OFFICIAL_API_HOST,
  type McpCredentialTestInput,
  type PartialAppSettings,
} from "../shared/types/settings";

const MCP_CREDENTIAL_KEYS = new Set(["moocsUsername", "moocsPassword"]);
const MAX_CHAT_CHARS = 8_000;
const MAX_EXTERNAL_URL_CHARS = 2_048;
const ALLOWED_SETTING_KEYS = new Set([
  "apiKey",
  "baseURL",
  "model",
  "moocsUsername",
  "moocsPassword",
]);
const ALLOWED_MODELS = new Set(["gpt-5.4-nano", "gpt-5.4-mini", "gpt-5.4"]);

function invalid(message: string): never {
  throw new AppError("INVALID_INPUT", message);
}

export function validateChatInput(value: unknown): string {
  if (typeof value !== "string") invalid("質問は文字列で入力してください");
  const trimmed = value.trim();
  if (!trimmed) invalid("質問を入力してください");
  if (trimmed.length > MAX_CHAT_CHARS) {
    invalid(`質問は ${MAX_CHAT_CHARS.toLocaleString()} 文字以内で入力してください`);
  }
  if (trimmed.includes("\0")) invalid("質問に使用できない文字が含まれています");
  return trimmed;
}

export function validateSettingsInput(value: unknown): PartialAppSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("設定データの形式が不正です");
  }

  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some((key) => !ALLOWED_SETTING_KEYS.has(key))) {
    invalid("許可されていない設定項目が含まれています");
  }

  const result: PartialAppSettings = {};
  for (const key of keys) {
    const settingValue = input[key];
    if (typeof settingValue !== "string") invalid(`${key} は文字列で指定してください`);
    if (settingValue.includes("\0") || /[\r\n]/.test(settingValue)) {
      invalid(`${key} に使用できない文字が含まれています`);
    }

    switch (key) {
      case "apiKey":
      case "moocsPassword":
        if (settingValue.length > 512) invalid(`${key} が長すぎます`);
        result[key] = settingValue;
        break;
      case "moocsUsername":
        if (settingValue.length > 254) invalid("MOOCs ユーザー名が長すぎます");
        result.moocsUsername = settingValue.trim();
        break;
      case "model":
        if (!ALLOWED_MODELS.has(settingValue)) invalid("許可されていないモデルです");
        result.model = settingValue;
        break;
      case "baseURL":
        result.baseURL = validateApiBaseUrl(settingValue);
        break;
    }
  }
  return result;
}

export function validateMcpCredentialTestInput(value: unknown): McpCredentialTestInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("接続テストのデータ形式が不正です");
  }

  const keys = Object.keys(value);
  if (keys.some((key) => !MCP_CREDENTIAL_KEYS.has(key))) {
    invalid("許可されていない設定項目が含まれています");
  }
  if (keys.length === 0) return {};

  const { moocsUsername, moocsPassword } = validateSettingsInput(value);
  const result: McpCredentialTestInput = {};
  if (keys.includes("moocsUsername")) {
    if (!moocsUsername) invalid("MOOCs ユーザー名を入力してください");
    result.moocsUsername = moocsUsername;
  }
  if (keys.includes("moocsPassword")) {
    if (!moocsPassword) invalid("MOOCs パスワードを入力してください");
    result.moocsPassword = moocsPassword;
  }
  return result;
}

export function validateApiBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid("API URL の形式が不正です");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== OFFICIAL_API_HOST ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    return invalid("API URL は公式 INIAD API の HTTPS URL のみ指定できます");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function validateExternalUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_EXTERNAL_URL_CHARS) {
    invalid("外部 URL の形式が不正です");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid("外部 URL の形式が不正です");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    isLocalOrPrivateHost(parsed.hostname)
  ) {
    return invalid("安全でない外部 URL は開けません");
  }
  return parsed.toString();
}

function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "::" ||
    host === "::1" ||
    host.startsWith("::ffff:") ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home") ||
    (!host.includes(".") && !host.includes(":"))
  ) {
    return true;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  const carrierNat = host.match(/^100\.(\d{1,3})\./);
  if (carrierNat && Number(carrierNat[1]) >= 64 && Number(carrierNat[1]) <= 127) return true;
  if (/^169\.254\./.test(host) || /^0\./.test(host)) return true;
  return (
    host.includes(":") &&
    (host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fec") ||
      host.startsWith("fed") ||
      host.startsWith("fee") ||
      host.startsWith("fef") ||
      host.startsWith("fe80:"))
  );
}
