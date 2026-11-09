/**
 * 設定関連の共通型定義
 * SettingsStore と設定画面で使用する型
 */

import type { ErrorCode } from "./errors";

/** アプリケーション設定（保存用・生の値） */
export interface AppSettings {
  /** INIAD API キー（Renderer には送信しない） */
  apiKey: string;
  /** API ベースURL */
  baseURL: string;
  /** デフォルトモデル名 */
  model: string;
  /** INIAD MOOCs ユーザー名（学籍番号） */
  moocsUsername: string;
  /** INIAD MOOCs パスワード（Renderer には送信しない） */
  moocsPassword: string;
}

/**
 * 設定画面（Renderer）への受け渡し用設定
 *
 * 機密フィールド（apiKey, moocsPassword）は値を含まず常に空文字列。
 * 設定済みかどうかは hasApiKey / hasMoocsCredentials フラグで示す。
 * これにより未編集の機密値が誤って上書き保存される事故を防ぐ。
 */
export interface PublicAppSettings {
  /** INIAD API キー（常に空文字列・値は送信しない） */
  apiKey: string;
  /** API ベースURL */
  baseURL: string;
  /** デフォルトモデル名 */
  model: string;
  /** INIAD MOOCs ユーザー名（学籍番号） */
  moocsUsername: string;
  /** INIAD MOOCs パスワード（常に空文字列・値は送信しない） */
  moocsPassword: string;
  /** API キーが保存済みか */
  hasApiKey: boolean;
  /** MOOCs 認証情報（ユーザー名＋パスワード）が保存済みか */
  hasMoocsCredentials: boolean;
}

/** 認証情報を送信してよい公式 INIAD API ホスト。 */
export const OFFICIAL_API_HOST = "api.openai.iniad.org";

/**
 * チャットに使うモデル。INIAD Slack の「gpt6-luna」と同じモデル。
 *
 * 設定画面では選ばせない。保存済みの設定に別のモデル名が残っていても、
 * 読み込み時にこの値へ戻す（SettingsStore の許可リスト）。
 */
export const CHAT_MODEL = "gpt-6-luna";

/** AppSettings のデフォルト値 */
export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: "",
  baseURL: `https://${OFFICIAL_API_HOST}/api/v1`,
  model: CHAT_MODEL,
  moocsUsername: "",
  moocsPassword: "",
};

/** MCP 接続状態 */
export type McpStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

/** Renderer に公開してよい、サニタイズ済みの MCP エラー情報 */
export interface McpConnectionError {
  code: ErrorCode;
  message: string;
  guidance: string;
  retryable: boolean;
}

/** Main が一元管理する MCP 接続スナップショット */
export interface McpConnectionState {
  status: McpStatus;
  lastConnectedAt?: string;
  error?: McpConnectionError;
  attempt?: number;
  maxAttempts?: number;
}

/** アプリケーション全体のステータス（app:status で返却） */
export interface AppStatus {
  /** MCP 接続状態 */
  mcpStatus: McpStatus;
  /** 詳細な MCP 接続状態 */
  mcpConnection: McpConnectionState;
  /** 現在使用中のモデル名 */
  model: string;
  /** API キーが設定済みか */
  hasApiKey: boolean;
}

/** 設定保存時の部分更新用（空文字列は既存値を維持） */
export type PartialAppSettings = Partial<AppSettings>;

/**
 * MOOCs 接続テストに渡す、画面で入力した認証情報。
 * 省略した項目は保存済みの値を使う。空のオブジェクトは保存済みの値でのテストを表す。
 */
export type McpCredentialTestInput = Partial<Pick<AppSettings, "moocsUsername" | "moocsPassword">>;

/** 接続テスト結果 */
export interface ConnectionTestResult {
  success: boolean;
  error?: string;
  guidance?: string;
}
