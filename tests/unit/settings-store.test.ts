import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

// safeStorage は vi.fn() で定義し、beforeEach で実装を設定する。
// 実際の safeStorage と同様に「暗号化が利用不可のときは
// encryptStringAsync/decryptStringAsync が reject する」挙動にして、フォールバック分岐を検証する。
// 同期 API（isEncryptionAvailable/encryptString/decryptString）は Electron 46 で削除されるため
// モックに含めず、実装が誤って呼んだ場合は TypeError で失敗させる。
vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => tmpdir()) },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(),
    getSelectedStorageBackend: vi.fn(),
    encryptStringAsync: vi.fn(),
    decryptStringAsync: vi.fn(),
  },
}));

import { safeStorage } from "electron";
import { SettingsStore, isSecureStorageAvailable } from "../../src/main/services/settings-store";

/** ファイルの存在チェック */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("SettingsStore", () => {
  let store: SettingsStore;
  let tempPath: string;
  let credPath: string;

  beforeEach(async () => {
    // safeStorage モック: 可用性チェックを通過した場合のみ成功（実装の呼び分けを検証）
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
    vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue("kwallet");
    vi.mocked(safeStorage.encryptStringAsync).mockImplementation(async (s: string) => {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        throw new Error("safeStorage unavailable");
      }
      return Buffer.from(s, "utf-8");
    });
    vi.mocked(safeStorage.decryptStringAsync).mockImplementation(async (b: Buffer) => {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        throw new Error("safeStorage unavailable");
      }
      return { result: b.toString("utf-8"), shouldReEncrypt: false };
    });

    tempPath = join(tmpdir(), `settings-test-${randomUUID()}.json`);
    credPath = join(dirname(tempPath), "credentials.enc");
    store = new SettingsStore();
    await store.init(tempPath);
  });

  afterEach(async () => {
    for (const p of [tempPath, credPath, `${credPath}.bak`]) {
      try {
        await fs.unlink(p);
      } catch {
        // ファイルがない場合は無視
      }
    }
  });

  // ── 基本テスト（暗号化下でも契約不变） ──

  it("credentials.enc の保存に失敗したら settings.json を元の値へ戻す", async () => {
    await store.updateSettings({ moocsUsername: "old-user", moocsPassword: "old-pass" });

    vi.mocked(safeStorage.encryptStringAsync).mockRejectedValueOnce(new Error("encrypt failed"));
    await expect(
      store.updateSettings({ moocsUsername: "new-user", moocsPassword: "new-pass" })
    ).rejects.toThrow("encrypt failed");

    expect(store.getRawSettings().moocsUsername).toBe("old-user");
    const reloaded = new SettingsStore();
    await reloaded.init(tempPath);
    expect(reloaded.getRawSettings()).toMatchObject({
      moocsUsername: "old-user",
      moocsPassword: "old-pass",
    });
  });

  it("updateSettings で apiKey が保存され getRawSettings で読める", async () => {
    await store.updateSettings({ apiKey: "sk-real" });
    expect(store.getRawSettings().apiKey).toBe("sk-real");
  });

  it("getSettings は機密フィールド（apiKey, moocsPassword）の値を含まない", async () => {
    await store.updateSettings({ apiKey: "sk-real", moocsPassword: "secret-pass" });
    const publicSettings = store.getSettings();
    expect(publicSettings.apiKey).toBe("");
    expect(publicSettings.moocsPassword).toBe("");
  });

  it("非機���フィールドは getSettings で実値が返る", async () => {
    await store.updateSettings({
      baseURL: "https://example.com/v1",
      model: "gpt-test",
      moocsUsername: "s1F10xxx@iniad.org",
    });
    const publicSettings = store.getSettings();
    expect(publicSettings.baseURL).toBe("https://example.com/v1");
    expect(publicSettings.model).toBe("gpt-test");
    expect(publicSettings.moocsUsername).toBe("s1F10xxx@iniad.org");
  });

  it("hasApiKey フラグが APIキーの設定済み状態を示す", async () => {
    expect(store.getSettings().hasApiKey).toBe(false);
    await store.updateSettings({ apiKey: "sk-real" });
    expect(store.getSettings().hasApiKey).toBe(true);
  });

  it("hasMoocsCredentials はユーザー名＋パスワードのペアが揃った時のみ true になる", async () => {
    expect(store.getSettings().hasMoocsCredentials).toBe(false);
    await store.updateSettings({ moocsUsername: "s1F10xxx@iniad.org" });
    expect(store.getSettings().hasMoocsCredentials).toBe(false);
    await store.updateSettings({ moocsPassword: "secret-pass" });
    expect(store.getSettings().hasMoocsCredentials).toBe(true);
  });

  it("getSettings の戻り値をそのまま updateSettings に送っても既存値が壊れない（リグレッション）", async () => {
    await store.updateSettings({ apiKey: "sk-real", moocsPassword: "secret-pass" });
    const echoed = store.getSettings();
    await store.updateSettings(echoed);

    expect(store.getRawSettings().apiKey).toBe("sk-real");
    expect(store.getRawSettings().moocsPassword).toBe("secret-pass");
  });

  // ── safeStorage 暗号化・2ファイル分離 ──

  it("保存した機密値はファイル再読込で正しく復元される（暗号化往復・マルチバイト含む）", async () => {
    await store.updateSettings({ apiKey: "sk-12345", moocsPassword: "パスワード123" });

    const reloaded = new SettingsStore();
    await reloaded.init(tempPath);
    expect(reloaded.getRawSettings().apiKey).toBe("sk-12345");
    expect(reloaded.getRawSettings().moocsPassword).toBe("パスワード123");
  });

  it("credentials.enc に機密の平文が含まれない", async () => {
    await store.updateSettings({ apiKey: "sk-secret-key", moocsPassword: "plain-secret-pass" });
    const credContent = await fs.readFile(credPath, "utf-8");
    expect(credContent).not.toContain("sk-secret-key");
    expect(credContent).not.toContain("plain-secret-pass");
  });

  it("settings.json には機密フィールドが含まれず、非機密のみ格納される", async () => {
    await store.updateSettings({ apiKey: "sk-real", moocsPassword: "secret" });
    const parsed = JSON.parse(await fs.readFile(tempPath, "utf-8"));
    expect(parsed).not.toHaveProperty("apiKey");
    expect(parsed).not.toHaveProperty("moocsPassword");
    expect(parsed).toHaveProperty("baseURL");
    expect(parsed).toHaveProperty("model");
    expect(parsed).toHaveProperty("moocsUsername");
  });

  it("再読込時に非公式API URL・未知モデル・不正なユーザー名を既定値へ戻す", async () => {
    await fs.writeFile(
      tempPath,
      JSON.stringify({
        baseURL: "http://attacker.example/v1",
        model: "unknown-model",
        moocsUsername: "student\nInjected",
      }),
      "utf-8"
    );

    const reloaded = new SettingsStore();
    await reloaded.init(tempPath);
    expect(reloaded.getRawSettings()).toEqual(
      expect.objectContaining({
        baseURL: "https://api.openai.iniad.org/api/v1",
        model: "gpt-5.4-nano",
        moocsUsername: "",
      })
    );
  });

  it("旧形式（平文 settings.json に機密含む）から credentials.enc に自動移行する", async () => {
    // init が作ったファイルを一旦削除し、旧形式の平文 settings.json を置く
    await fs.unlink(tempPath);
    if (await exists(credPath)) await fs.unlink(credPath);
    const legacy = {
      apiKey: "legacy-key",
      baseURL: "https://legacy.example.com/v1",
      model: "gpt-legacy",
      moocsUsername: "legacy-user",
      moocsPassword: "legacy-pass",
    };
    await fs.writeFile(tempPath, JSON.stringify(legacy, null, 2), "utf-8");

    const migrated = new SettingsStore();
    await migrated.init(tempPath);

    // 機密は credentials.enc から復元
    expect(migrated.getRawSettings().apiKey).toBe("legacy-key");
    expect(migrated.getRawSettings().moocsPassword).toBe("legacy-pass");
    // 非機密も保持
    expect(migrated.getRawSettings().baseURL).toBe("https://api.openai.iniad.org/api/v1");
    expect(migrated.getRawSettings().moocsUsername).toBe("legacy-user");

    // settings.json から機密が削除されている
    const settingsAfter = JSON.parse(await fs.readFile(tempPath, "utf-8"));
    expect(settingsAfter).not.toHaveProperty("apiKey");
    expect(settingsAfter).not.toHaveProperty("moocsPassword");
    // credentials.enc が生成され、平文を含まない
    expect(await exists(credPath)).toBe(true);
    const credContent = await fs.readFile(credPath, "utf-8");
    expect(credContent).not.toContain("legacy-key");
    expect(credContent).not.toContain("legacy-pass");
  });

  it("credentials.enc が既存の場合は settings.json の旧機密を無視し credentials.enc を正とする", async () => {
    // まず credentials.enc を新しい機密で作成
    await store.updateSettings({ apiKey: "fresh-key", moocsPassword: "fresh-pass" });
    // settings.json に古い機密が残っている（旧形式）状態を再現
    const staleSettings = {
      apiKey: "stale-key",
      baseURL: "https://example.com/v1",
      model: "gpt-test",
      moocsUsername: "user",
      moocsPassword: "stale-pass",
    };
    await fs.writeFile(tempPath, JSON.stringify(staleSettings, null, 2), "utf-8");

    const reloaded = new SettingsStore();
    await reloaded.init(tempPath);

    // credentials.enc 側の新しい機密が優先される
    expect(reloaded.getRawSettings().apiKey).toBe("fresh-key");
    expect(reloaded.getRawSettings().moocsPassword).toBe("fresh-pass");
    // settings.json から機密が削除されて正規化される
    const settingsAfter = JSON.parse(await fs.readFile(tempPath, "utf-8"));
    expect(settingsAfter).not.toHaveProperty("apiKey");
    expect(settingsAfter).not.toHaveProperty("moocsPassword");
  });

  it("credentials.enc の復号に失敗した場合は .bak に退避し機密は空にフォールバックする", async () => {
    await store.updateSettings({ apiKey: "sk-real", moocsPassword: "secret" });
    // credentials.enc を復号不能な内容で破損させる（JSON パース失敗を引き起こす）
    await fs.writeFile(credPath, "this-is-not-valid-encrypted-content", "utf-8");

    const reloaded = new SettingsStore();
    await reloaded.init(tempPath);

    expect(reloaded.getRawSettings().apiKey).toBe("");
    expect(reloaded.getRawSettings().moocsPassword).toBe("");
    expect(await exists(`${credPath}.bak`)).toBe(true);
  });

  it("safeStorage.decryptStringAsync 自体が reject する場合も .bak に退避し機密は空にフォールバックする", async () => {
    await store.updateSettings({ apiKey: "sk-real", moocsPassword: "secret" });
    // decryptStringAsync が reject する状況（OS 復号エラー相当）をシミュレート
    vi.mocked(safeStorage.decryptStringAsync).mockRejectedValue(new Error("decrypt failed"));

    const reloaded = new SettingsStore();
    await reloaded.init(tempPath);

    expect(reloaded.getRawSettings().apiKey).toBe("");
    expect(reloaded.getRawSettings().moocsPassword).toBe("");
    expect(await exists(`${credPath}.bak`)).toBe(true);
  });

  it("safeStorage が利用不可の場合は秘密情報を平文保存しない", async () => {
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);

    const fallback = new SettingsStore();
    await fallback.init(tempPath);
    await expect(
      fallback.updateSettings({ apiKey: "sk-fallback", moocsPassword: "fallback-pass" })
    ).rejects.toThrow("安全な資格情報ストレージ");
    expect(await exists(credPath)).toBe(false);
    expect(fallback.getRawSettings().apiKey).toBe("");
    expect(fallback.getRawSettings().moocsPassword).toBe("");
  });

  it("Linux の basic_text バックエンドを安全な保存先として扱わない", async () => {
    vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue("basic_text");
    await expect(isSecureStorageAvailable("linux")).resolves.toBe(false);
    // basic_text の判定は Linux に限る
    await expect(isSecureStorageAvailable("win32")).resolves.toBe(true);
  });

  it("Linux の basic_text では資格情報を保存しない", async () => {
    vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue("basic_text");
    vi.mocked(safeStorage.encryptStringAsync).mockClear();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      await expect(store.updateSettings({ apiKey: "sk-basic-text" })).rejects.toThrow(
        "安全な資格情報ストレージ"
      );
      expect(await exists(credPath)).toBe(false);
      expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("decryptStringAsync が shouldReEncrypt を返したら暗号化し直して保存する", async () => {
    await store.updateSettings({ apiKey: "sk-rotate", moocsPassword: "rotate-pass" });
    vi.mocked(safeStorage.encryptStringAsync).mockClear();
    vi.mocked(safeStorage.decryptStringAsync).mockImplementationOnce(async (b: Buffer) => ({
      result: b.toString("utf-8"),
      shouldReEncrypt: true,
    }));

    const reloaded = new SettingsStore();
    await reloaded.init(tempPath);

    expect(reloaded.getRawSettings()).toMatchObject({
      apiKey: "sk-rotate",
      moocsPassword: "rotate-pass",
    });
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledTimes(1);
    expect(await exists(credPath)).toBe(true);
    expect(await exists(`${credPath}.bak`)).toBe(false);
  });

  it("再暗号化に失敗しても復号できた資格情報を退避しない", async () => {
    await store.updateSettings({ apiKey: "sk-keep", moocsPassword: "keep-pass" });
    const before = await fs.readFile(credPath, "utf-8");
    vi.mocked(safeStorage.decryptStringAsync).mockImplementationOnce(async (b: Buffer) => ({
      result: b.toString("utf-8"),
      shouldReEncrypt: true,
    }));
    vi.mocked(safeStorage.encryptStringAsync).mockRejectedValueOnce(new Error("encrypt failed"));

    const reloaded = new SettingsStore();
    await reloaded.init(tempPath);

    expect(reloaded.getRawSettings().apiKey).toBe("sk-keep");
    expect(await fs.readFile(credPath, "utf-8")).toBe(before);
    expect(await exists(`${credPath}.bak`)).toBe(false);
  });

  it("旧版の平文フォールバックは safeStorage で暗号化し直す", async () => {
    const plaintext = JSON.stringify({ apiKey: "legacy-key", moocsPassword: "legacy-pass" });
    await fs.writeFile(credPath, `plaintext:${Buffer.from(plaintext).toString("base64")}`, "utf-8");

    const migrated = new SettingsStore();
    await migrated.init(tempPath);

    expect(migrated.getRawSettings().apiKey).toBe("legacy-key");
    const stored = await fs.readFile(credPath, "utf-8");
    expect(stored).not.toContain("plaintext:");
    expect(stored).not.toContain("legacy-key");
  });

  it("暗号化できない環境では旧版の平文資格情報を残さない", async () => {
    const plaintext = JSON.stringify({ apiKey: "legacy-key", moocsPassword: "legacy-pass" });
    await fs.writeFile(credPath, `plaintext:${Buffer.from(plaintext).toString("base64")}`, "utf-8");
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);

    const migrated = new SettingsStore();
    await migrated.init(tempPath);

    expect(migrated.getRawSettings().apiKey).toBe("");
    expect(migrated.getRawSettings().moocsPassword).toBe("");
    expect(await exists(credPath)).toBe(false);
  });
});
