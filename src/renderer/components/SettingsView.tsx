import React, { useState, useEffect } from "react";
import type { AppSettings, PublicAppSettings } from "../../shared/types";
import { DEFAULT_SETTINGS, OFFICIAL_API_HOST } from "../../shared/types";
import { buildMcpTestRequest, buildSavePayload, isMcpCredentialField } from "./mcp-test-request";

/** バリデーションエラーの型 */
interface ValidationErrors {
  apiKey?: string;
  baseURL?: string;
  moocsUsername?: string;
  moocsPassword?: string;
}

/** 接続テスト結果 */
interface TestResult {
  status: "idle" | "testing" | "success" | "error";
  message?: string;
}

interface SettingsViewProps {
  /** 設定画面を閉じてチャット画面に戻る */
  onClose: () => void;
}

/** URLバリデーション */
function isValidURL(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === OFFICIAL_API_HOST &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port
    );
  } catch {
    return false;
  }
}

function validateSettings(
  current: PublicAppSettings,
  edited: ReadonlySet<keyof AppSettings>
): ValidationErrors {
  const errs: ValidationErrors = {};

  // APIキー: 編集済みかつ空の場合のみエラー
  if (edited.has("apiKey") && !current.apiKey.trim()) {
    errs.apiKey = "APIキーは必須です";
  }

  // ベースURL
  if (current.baseURL && !isValidURL(current.baseURL)) {
    errs.baseURL = "公式 INIAD API の HTTPS URL を入力してください";
  }

  // MOOCsユーザー名・パスワードはペア入力（空のパスワード欄は「変更なし」を表す）
  const hasUsername = current.moocsUsername.trim().length > 0;
  const hasTypedPassword = current.moocsPassword.trim().length > 0;

  if (hasUsername && !hasTypedPassword && !current.hasMoocsCredentials) {
    errs.moocsPassword = "パスワードも入力してください";
  }
  if (!hasUsername && hasTypedPassword) {
    errs.moocsUsername = "ユーザー名も入力してください";
  }

  return errs;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ onClose }) => {
  // ── State ──
  // settings は表示用（PublicAppSettings）。機密値は含まず、設定済みフラグで状態を示す。
  const [settings, setSettings] = useState<PublicAppSettings>({
    ...DEFAULT_SETTINGS,
    hasApiKey: false,
    hasMoocsCredentials: false,
  });
  const [editedFields, setEditedFields] = useState<Set<keyof AppSettings>>(new Set());
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [showApiKey, setShowApiKey] = useState(false);
  const [showMoocsPassword, setShowMoocsPassword] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [mcpTestResult, setMcpTestResult] = useState<TestResult>({ status: "idle" });
  // 接続テストで失敗した認証情報を、別の項目の「保存」で一緒に保存しないための印。
  const [mcpCredentialsRejected, setMcpCredentialsRejected] = useState(false);
  const isTestingMcp = mcpTestResult.status === "testing";
  const mcpTestRequest = buildMcpTestRequest(settings, editedFields);
  const hasTypedMcpCredentials = Object.keys(mcpTestRequest.input).length > 0;

  // ── 初期読み込み ──
  useEffect(() => {
    const loadSettings = async () => {
      try {
        // Main プロセスの IPC ハンドラが未登録の場合はスキップ
        if (window.electronAPI?.getSettings) {
          const loaded = await window.electronAPI.getSettings();
          setSettings({ ...DEFAULT_SETTINGS, ...loaded });
        }
      } catch {
        // IPC ハンドラ未登録時のエラーは無視（モック動作）
      }
    };
    loadSettings();
  }, []);

  // ── フィールド更新 ──
  const updateField = (field: keyof AppSettings, value: string) => {
    const newSettings = { ...settings, [field]: value };
    const newEditedFields = new Set(editedFields).add(field);
    setSettings(newSettings);
    setEditedFields(newEditedFields);
    setSaveMessage(null);
    if (isMcpCredentialField(field)) {
      setMcpTestResult({ status: "idle" });
      setMcpCredentialsRejected(false);
    }

    // バリデーションを実行
    setErrors(validateSettings(newSettings, newEditedFields));
  };

  // ── 保存とUI同期 ──
  // 編集済みフィールドを保存したあと getSettings で再取得し、
  // hasApiKey/hasMoocsCredentials と機密入力欄を実際の状態に同期する。
  // 接続テストで失敗した認証情報は保存せず、入力欄に残す。戻り値は残した項目があるか。
  const persistAndSync = async (): Promise<boolean> => {
    const partial = buildSavePayload(settings, editedFields, mcpCredentialsRejected);
    if (Object.keys(partial).length > 0 && window.electronAPI?.saveSettings) {
      await window.electronAPI.saveSettings(partial);
    }

    const keptFields = mcpCredentialsRejected ? [...editedFields].filter(isMcpCredentialField) : [];
    setEditedFields(new Set(keptFields));
    if (window.electronAPI?.getSettings) {
      const reloaded = await window.electronAPI.getSettings();
      setSettings({
        ...DEFAULT_SETTINGS,
        ...reloaded,
        ...(keptFields.length > 0
          ? { moocsUsername: settings.moocsUsername, moocsPassword: settings.moocsPassword }
          : {}),
      });
    }
    return keptFields.length > 0;
  };

  // ── 保存 ──
  const handleSave = async () => {
    const validationErrors = validateSettings(settings, editedFields);
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) {
      setSaveMessage({ type: "error", text: "入力内容にエラーがあります" });
      return;
    }

    setIsSaving(true);
    setSaveMessage(null);

    try {
      const keptCredentials = await persistAndSync();

      setSaveMessage({
        type: "success",
        text: keptCredentials
          ? "設定を保存しました（接続テストに失敗した学籍番号とパスワードは保存していません）"
          : "設定を保存しました",
      });

      // 3秒後にメッセージをクリア
      setTimeout(() => setSaveMessage(null), 3000);
    } catch (e) {
      setSaveMessage({
        type: "error",
        text: `保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setIsSaving(false);
    }
  };

  // ── 接続テスト ──
  // テスト中は入力を保存しない。ログインを確認できた値だけを Main が保存し、
  // 失敗したときは入力欄と保存済みの値をどちらも残す。
  const handleTestMcp = async () => {
    const { canTest, input } = mcpTestRequest;
    if (!canTest || isTestingMcp) return;

    setMcpTestResult({ status: "testing", message: "MOOCs へのログインを確認しています" });
    setSaveMessage(null);
    try {
      const result = await window.electronAPI.testMcpConnection(input);
      setMcpCredentialsRejected(!result.success);
      if (!result.success) {
        setMcpTestResult({
          status: "error",
          message: [result.error || "接続失敗", result.guidance].filter(Boolean).join(" "),
        });
        return;
      }

      if (Object.keys(input).length > 0) {
        // 他の項目の未保存の入力を消さないよう、保存された認証情報の欄だけを更新する。
        setSettings((prev) => ({
          ...prev,
          moocsUsername: input.moocsUsername ?? prev.moocsUsername,
          moocsPassword: "",
          hasMoocsCredentials: true,
        }));
        setEditedFields((prev) => {
          const next = new Set(prev);
          next.delete("moocsUsername");
          next.delete("moocsPassword");
          return next;
        });
        setErrors((prev) => {
          const next = { ...prev };
          delete next.moocsUsername;
          delete next.moocsPassword;
          return next;
        });
      }
      setMcpTestResult({
        status: "success",
        message: Object.keys(input).length > 0 ? "ログインを確認して保存しました" : "ログイン成功",
      });
    } catch (e) {
      setMcpCredentialsRejected(true);
      setMcpTestResult({
        status: "error",
        message: e instanceof Error ? e.message : "テスト失敗",
      });
    }
  };

  // ── 表示ヘルパー ──
  const renderTestButton = (
    label: string,
    result: TestResult,
    onTest: () => void,
    disabled: boolean
  ) => (
    <div className="settings-test-row">
      <button
        type="button"
        className="settings-test-button"
        onClick={onTest}
        disabled={disabled || result.status === "testing"}
      >
        {result.status === "testing" ? "テスト中..." : label}
      </button>
      {result.status !== "idle" && (
        <span className={`settings-test-result ${result.status}`}>
          {result.status === "testing" && (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="settings-icon-spin"
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          )}
          {result.status === "success" && (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#a6e3a1"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
          {result.status === "error" && (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#f38ba8"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          )}
          {result.message && ` ${result.message}`}
        </span>
      )}
    </div>
  );

  return (
    <div className="settings-view" id="settings-view">
      <div className="settings-content">
        {/* ── API設定セクション ── */}
        <section className="settings-section" id="settings-api">
          <h3 className="settings-section-title">
            <span className="settings-section-icon">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
              </svg>
            </span>
            API設定
          </h3>

          <div className="settings-field">
            <label className="settings-label" htmlFor="settings-apiKey">
              APIキー
            </label>
            <div className="settings-input-group">
              <input
                id="settings-apiKey"
                type={showApiKey ? "text" : "password"}
                className={`settings-input settings-secret-input ${errors.apiKey ? "error" : ""}`}
                value={settings.apiKey}
                onChange={(e) => updateField("apiKey", e.target.value)}
                placeholder={settings.hasApiKey ? "設定済み（変更時のみ入力）" : "sk-..."}
                autoComplete="off"
              />
              <button
                type="button"
                className={`settings-toggle-visibility ${showApiKey ? "active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setShowApiKey(true);
                }}
                onMouseUp={() => setShowApiKey(false)}
                onMouseLeave={() => setShowApiKey(false)}
                aria-label="長押しでAPIキーを表示"
                title="長押しで表示"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            </div>
            {errors.apiKey && <span className="settings-error">{errors.apiKey}</span>}
            <span className="settings-hint">
              {settings.hasApiKey
                ? "✓ APIキーは設定済みです（変更時のみ入力）"
                : "※ INIAD Slack の「gpt6-luna」で取得可能"}
            </span>
          </div>

          <div className="settings-field">
            <label className="settings-label" htmlFor="settings-baseURL">
              APIベースURL
            </label>
            <input
              id="settings-baseURL"
              type="text"
              className={`settings-input ${errors.baseURL ? "error" : ""}`}
              value={settings.baseURL}
              onChange={(e) => updateField("baseURL", e.target.value)}
              placeholder={DEFAULT_SETTINGS.baseURL}
            />
            {errors.baseURL && <span className="settings-error">{errors.baseURL}</span>}
          </div>
        </section>

        {/* ── MOOCs認証セクション ── */}
        <section className="settings-section" id="settings-moocs">
          <h3 className="settings-section-title">
            <span className="settings-section-icon">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
                <path d="M6 12v5c0 2 2 3 6 3s6-1 6-3v-5" />
              </svg>
            </span>
            INIAD MOOCs 認証
          </h3>
          <p className="settings-section-description">
            学籍番号とパスワードを入力して、接続テストを押してください。MOOCs
            へのログインを確認し、成功したときに保存します。失敗しても入力と保存済みの値は変わらず、失敗した値は「保存」でも保存しません。テスト中は今の接続がいったん切れます。起動時・チャット送信時にも自動接続を試みます。
          </p>

          <div className="settings-field">
            <label className="settings-label" htmlFor="settings-moocsUsername">
              ユーザー名（学籍番号）
            </label>
            <input
              id="settings-moocsUsername"
              type="text"
              className={`settings-input ${errors.moocsUsername ? "error" : ""}`}
              value={settings.moocsUsername}
              onChange={(e) => updateField("moocsUsername", e.target.value)}
              placeholder="s1F10XXXXXX"
              autoComplete="off"
              disabled={isTestingMcp}
            />
            {errors.moocsUsername && <span className="settings-error">{errors.moocsUsername}</span>}
          </div>

          <div className="settings-field">
            <label className="settings-label" htmlFor="settings-moocsPassword">
              パスワード
            </label>
            <div className="settings-input-group">
              <input
                id="settings-moocsPassword"
                type={showMoocsPassword ? "text" : "password"}
                className={`settings-input settings-secret-input ${errors.moocsPassword ? "error" : ""}`}
                value={settings.moocsPassword}
                onChange={(e) => updateField("moocsPassword", e.target.value)}
                placeholder={
                  settings.hasMoocsCredentials ? "設定済み（変更時のみ入力）" : "パスワード"
                }
                autoComplete="off"
                disabled={isTestingMcp}
              />
              <button
                type="button"
                className={`settings-toggle-visibility ${showMoocsPassword ? "active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setShowMoocsPassword(true);
                }}
                onMouseUp={() => setShowMoocsPassword(false)}
                onMouseLeave={() => setShowMoocsPassword(false)}
                aria-label="長押しでパスワードを表示"
                title="長押しで表示"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            </div>
            {errors.moocsPassword && <span className="settings-error">{errors.moocsPassword}</span>}
          </div>

          {renderTestButton(
            hasTypedMcpCredentials ? "接続テストして保存" : "接続テスト",
            mcpTestResult,
            handleTestMcp,
            !mcpTestRequest.canTest
          )}
          {!mcpTestRequest.canTest && (
            <span className="settings-hint">
              学籍番号とパスワードの両方を入力するとテストできます
            </span>
          )}
        </section>
      </div>

      {/* ── フッター（保存・キャンセル） ── */}
      <div className="settings-footer">
        {saveMessage && (
          <span className={`settings-save-message ${saveMessage.type}`}>
            {saveMessage.type === "success" ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#a6e3a1"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ verticalAlign: "middle", marginRight: "4px" }}
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#f38ba8"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ verticalAlign: "middle", marginRight: "4px" }}
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            )}
            {saveMessage.text}
          </span>
        )}
        <div className="settings-footer-buttons">
          <button
            type="button"
            className="settings-button-cancel"
            onClick={onClose}
            disabled={isTestingMcp}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="settings-button-save"
            onClick={handleSave}
            disabled={isSaving || isTestingMcp || Object.keys(errors).length > 0}
          >
            {isSaving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
};
