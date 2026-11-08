# INIAD AI Chat Enhanced 設計書（MVP）

> [!NOTE]
> **この文書は MVP 時点（2026 年 4 月）の初期設計です。現在の実装とは異なります。**
> 当時の設計判断の記録として残しています。現在の動作はソースコードを正としてください。
>
> 主な違いは次のとおりです。
>
> | 項目 | この文書（初期設計） | 現在の実装 |
> | --- | --- | --- |
> | 回答の生成 | 検索してからプロンプトを組み立てる固定の RAG パイプライン（§6.4、§8、§9） | LLM がツールを選んで MOOCs を調べるエージェント型（`src/main/services/chat-agent.ts`）。2026 年 6 月の PR #21 で移行 |
> | MCP サーバーの起動 | `npx` 経由で自動起動（§1、§6.5） | Node.js、MCP、Chromium を `.mcp-runtime` にまとめて配布物に同梱し、起動前に SHA-256 で照合（README の「MCP 配布ランタイム」） |
> | Web 検索 | `google-sr` によるスクレイピング（§6.8） | DuckDuckGo Instant Answer API（`src/main/services/web-search-client.ts`） |
> | 設定画面の接続テスト | API と MCP の両方（§6.3 の `settings:test-api`、`settings:test-mcp`） | MOOCs のみ。入力した値でログインを確かめてから保存する（PR #29） |
>
> §6.7（設定の保存）は 2026 年 7 月に、設定済みフラグ方式と safeStorage による暗号化へ更新済みです。
> `docs/assignment.md` が参照する §6.3 の IPC 定義も、当時の内容のまま残しています。

## 1. 設計方針

- MVP は「MOOCs 資料に基づく回答品質」を最優先とする
- 既存 Electron プロジェクト（electron-forge）を基盤に短期間で実装可能な構成を採用する
- 将来的な検索拡張に備え、責務分離したレイヤー構成にする
- MCP クライアントは `@modelcontextprotocol/sdk` を用いて stdio 通信で実装する
- **設定はアプリ内設定画面から行う**（`.env` 編集を不要とする）。設定値は Electron のユーザデータディレクトリに JSON で永続化する
- **MCP サーバ（`@rarandeyo/iniad-moocs-mcp`）は `npx` 経由で自動起動**し、ユーザが個別にセットアップしなくても動作する組み込み方式を採用する
- **TypeScript ビルドパイプライン**: electron-forge と `tsconfig.json`（strict モード）により、Main・Renderer・Preload 全プロセスで型安全な開発を保証する
- **セキュリティヘッダー**: Renderer の HTML に CSP（Content-Security-Policy）meta タグを設定し、外部スクリプト読み込みやインラインスクリプトを制限する

## 2. システム構成

```text
┌───────────────────────────────────────────────────────┐
│                Electron Renderer Process               │
│  ┌─────────────────────────────────────────────────┐  │
│  │ index.html + index.css + renderer.tsx (React)   │  │
│  │ ┌──────────┐ ┌───────────────┐ ┌────────────┐  │  │
│  │ │ ChatView │ │ CitationPanel │ │ StatusBar  │  │  │
│  │ └──────────┘ └───────────────┘ └────────────┘  │  │
│  └──────────────────────┬──────────────────────────┘  │
│               contextBridge (preload.ts)              │
└─────────────────────────┼─────────────────────────────┘
                          │ IPC
┌─────────────────────────┼─────────────────────────────┐
│            Electron Main Process (index.ts)            │
│  ┌──────────────┐                                      │
│  │ IPC Handlers │──chat:send──┐                        │
│  │              │──chat:list──┤                        │
│  │              │──chat:clear─┤                        │
│  │              │──app:status─┘                        │
│  └──────┬───────┘                                      │
│         ▼                                              │
│  ┌──────────────────────────────────────────────┐     │
│  │              Chat Service                     │     │
│  │  ┌────────────┐ ┌────────────┐ ┌──────────┐ │     │
│  │  │ Retrieval  │ │ Prompt     │ │ Response │ │     │
│  │  │Orchestrator│ │ Composer   │ │ Composer │ │     │
│  │  └─────┬──────┘ └─────┬──────┘ └────┬─────┘ │     │
│  └────────┼──────────────┼─────────────┼────────┘     │
│           │              │             │               │
│  ┌────────▼────────┐          ┌────────▼────────┐     │
│  │ MCP Client      │          │ INIAD API       │     │
│  │ (MOOCs検索)     │          │ Client (LLM)    │     │
│  └────────┬────────┘          └────────┬────────┘     │
│           │                            │               │
│  ┌────────▼────────┐                   │               │
│  │ Search Client   │                   │               │
│  │ (google-sr)     │                   │               │
│  └─────────────────┘                   │               │
└──────────────────────────┼────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼                         ▼
     ┌─────────────────┐      ┌─────────────────┐
     │ INIAD-MOOCs-MCP │      │ INIAD API       │
     │ Server (stdio)  │      │ (OpenAI互換)    │
     └─────────────────┘      └─────────────────┘
```

## 3. ディレクトリ構造

```text
iniad-ai-chat-enhanced/
├── docs/                        # 本ドキュメント群
│   ├── proposal.md
│   ├── design.md
│   └── assignment.md
├── src/
│   ├── main/                    # Main プロセス
│   │   ├── index.ts             # エントリポイント（BrowserWindow生成）
│   │   ├── ipc-handlers.ts      # IPC チャネル定義・ハンドラ
│   │   └── services/
│   │       ├── chat-service.ts       # チャット統合サービス
│   │       ├── retrieval-orchestrator.ts  # 資料検索統合
│       │       ├── prompt-composer.ts     # プロンプト合成
│       │       ├── response-composer.ts   # レスポンス整形
│       │       ├── iniad-api-client.ts    # INIAD API 呼び出し
│       │       ├── mcp-client.ts          # MCP クライアント
│       │       ├── search-client.ts       # 検索エンジンスクレイピング
│       │       └── settings-store.ts      # 設定の永続化・読込
│   ├── renderer/                # Renderer プロセス
│   │   ├── index.html           # メインHTML
│   │   ├── index.css            # スタイル
│   │   ├── renderer.tsx         # React エントリ
│   │   ├── App.tsx              # ルートコンポーネント
│   │   ├── index.css.d.ts       # CSS モジュール型宣言
│   │   └── components/          # UI コンポーネント（必要に応じて）
│   ├── preload/
│   │   └── preload.ts           # contextBridge 定義
│   └── shared/
│       └── types/               # 共通型定義（責務ごとに分割）
│           ├── index.ts          #   Barrel export
│           ├── chat.ts           #   ChatTurn, ChatResponse, Citation
│           ├── settings.ts      #   AppSettings, AppStatus
│           ├── search.ts        #   SearchResult, MoocsResult
│           └── errors.ts        #   AppError
├── webpack.main.config.js       # Main プロセス webpack 設定
├── webpack.preload.config.js    # Preload webpack 設定
├── webpack.renderer.config.js   # Renderer webpack 設定
├── webpack.rules.js             # webpack ローダルール
├── webpack.plugins.js           # webpack プラグイン
├── tsconfig.json                # TypeScript 設定（strict: true, パスエイリアス）
├── forge.config.ts              # electron-forge 設定（TypeScript コンパイル・パッケージング）
├── .env                         # 環境変数（.gitignore 対象、初回フォールバックのみ）
├── .env.example                 # 環境変数テンプレート
├── .gitignore
└── package.json
```

## 4. 機能要件（MVP）

| ID  | 機能                      | 優先度 | 説明                                                       |
| --- | ------------------------- | ------ | ---------------------------------------------------------- |
| F01 | チャット送受信            | 必須   | ユーザがテキスト入力し、LLM の回答を表示                   |
| F02 | MOOCs 資料検索            | 必須   | MCP 経由で INIAD MOOCs の講義資料を検索                    |
| F03 | RAG 回答生成              | 必須   | 検索結果をコンテキストとして LLM に回答生成させる          |
| F04 | 参照元表示                | 必須   | 回答の根拠となった資料のタイトル・リンク・スニペットを表示 |
| F05 | フォールバック            | 必須   | MCP 未接続時はプレーン会話に自動切替                       |
| F06 | エラー表示                | 必須   | 接続失敗・資料未取得時にユーザへ分かりやすいガイド表示     |
| F07 | 会話履歴                  | 推奨   | セッション内の会話履歴を保持・表示                         |
| F08 | ステータス表示            | 推奨   | MCP接続状態・処理中インジケータの表示                      |
| F09 | Web検索（スクレイピング） | 推奨   | Google等の検索エンジンからの一般情報補助検索               |
| F10 | 設定画面                  | 必須   | APIキー・モデル・INIAD MOOCs認証情報をアプリ内で設定       |
| F11 | 並行リクエスト制御        | 必須   | 送信中は入力・送信ボタンを無効化し、二重送信を防止         |

## 5. 非機能要件（MVP）

| ID   | 要件         | 目標値                                          | 測定方法                      |
| ---- | ------------ | ----------------------------------------------- | ----------------------------- |
| NF01 | 応答性能     | 通常質問で 5〜10秒以内                          | ユーザ体感時間                |
| NF02 | 可用性       | MCP 未接続時でもプレーン会話が可能              | フォールバック動作確認        |
| NF03 | セキュリティ | APIキーを Renderer に露出しない                 | コードレビュー                |
| NF04 | 拡張性       | 検索プロバイダ追加が1ファイル変更で可能         | インターフェース準拠          |
| NF05 | テスト       | 主要サービス層のユニットテストカバレッジ80%以上 | Vitest + カバレッジレポート   |
| NF06 | レスポンス   | MCP連携時のエンドツーエンド応答10秒以内         | 計測ログ（`latencyMs`）の検証 |

## 6. コンポーネント設計

### 6.1 Renderer（UI）

**役割**: ユーザ入力・メッセージ表示・参照元表示・状態表示

**画面構成**:

**チャット画面**:

```text
┌────────────────────────────────────────────┐
│  INIAD AI Chat Enhanced          [⚙ 設定]  │
├────────────────────────────────────────────┤
│  ┌──────────────────────────────────────┐  │
│  │  [User] Pythonのリスト内包表記について  │  │
│  │        教えてください                  │  │
│  ├──────────────────────────────────────┤  │
│  │  [AI] リスト内包表記は...（回答文）     │  │
│  │                                      │  │
│  │  📄 参照元:                           │  │
│  │    • Python基礎 第5回 スライド p.12   │  │
│  │      https://moocs.iniad.org/...     │  │
│  │    • Python基礎 第5回 演習問題        │  │
│  │      https://moocs.iniad.org/...     │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  ┌──────────────────────────────┐ [送信]   │
│  │  質問を入力...               │          │
│  └──────────────────────────────┘          │
│  ● MCP接続済み | モデル: GPT-5.4-nano     │
└────────────────────────────────────────────┘
```

**設定画面**（[⚙ 設定] クリックで表示）:

```text
┌────────────────────────────────────────────┐
│  ← 戻る      設定                          │
├────────────────────────────────────────────┤
│                                            │
│  ── INIAD API ──────────────────────────── │
│                                            │
│  APIキー                                   │
│  ┌──────────────────────────────┐          │
│  │  sk-••••••••••••••••         │  [表示]  │
│  └──────────────────────────────┘          │
│  ※ INIAD Slack「GPT-4o mini」で取得可能   │
│                                            │
│  API ベースURL                             │
│  ┌──────────────────────────────────────┐  │
│  │ https://api.openai.iniad.org/api/v1  │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  デフォルトモデル                           │
│  ┌──────────────────────────────┐          │
│  │ gpt-5.4-nano              ▼  │          │
│  └──────────────────────────────┘          │
│                                            │
│  ── INIAD MOOCs 連携 ───────────────────── │
│                                            │
│  MOOCs ユーザ名（学籍番号）                │
│  ┌──────────────────────────────┐          │
│  │ s1F10XXXXXX                  │          │
│  └──────────────────────────────┘          │
│                                            │
│  MOOCs パスワード                          │
│  ┌──────────────────────────────┐          │
│  │ ••••••••••                   │  [表示]  │
│  └──────────────────────────────┘          │
│                                            │
│  ── 接続テスト ──────────────────────────  │
│                                            │
│  [ API 接続テスト ]  [ MCP 接続テスト ]     │
│                                            │
│           [ 保存 ]       [ キャンセル ]     │
│                                            │
└────────────────────────────────────────────┘
```

**禁止事項**:

- APIキー・パス��ードの Renderer への値の送信（設定画面では空欄＋設定済みフラ��のみ）
- 外部APIの直接呼び出し
- Node.js 組み込みモジュールの使用

**状態管理**:

- `messages`: `ChatTurn[]`（会話履歴）
- `isLoading`: `boolean`（送信中フラグ）
- `mcpStatus`: `'connected' | 'disconnected' | 'connecting'`
- `error`: `string | null`
- `currentView`: `'chat' | 'settings'`（画面切替）
- `settings`: `PublicAppSettings`（機密値は空文字列・設定済みフラグ含む）

**送信中 UI 制御**（F11）:

- `sendChat` 呼び出し前に `isLoading = true` を設定し、入力フィールドと送信ボタンを `disabled` にする
- レスポンス受信またはエラー時に `isLoading = false` に復帰し、入力を再有効化する
- これにより二重送信を防止する

**CSP（Content-Security-Policy）**:

```html
<!-- index.html -->
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.openai.iniad.org; img-src 'self' https:;"
/>
```

### 6.2 Preload（contextBridge）

**役割**: Renderer と Main の安全な橋渡し

```ts
// preload.ts で公開する API
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  // チャット操作
  sendChat: (userText: string): Promise<ChatResponse> =>
    ipcRenderer.invoke("chat:send", userText),

  // 会話履歴
  getChatHistory: (): Promise<ChatTurn[]> => ipcRenderer.invoke("chat:list"),
  clearHistory: (): Promise<void> => ipcRenderer.invoke("chat:clear"),

  // ステータス
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke("app:status"),

  // 設定
  getSettings: (): Promise<PublicAppSettings> => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: Partial<AppSettings>): Promise<void> =>
    ipcRenderer.invoke("settings:set", settings),
  testApiConnection: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("settings:test-api"),
  testMcpConnection: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("settings:test-mcp"),

  // イベントリスナ（unsubscribe 用の cleanup 関数を返す）
  onMcpStatusChange: (callback: (status: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: string) =>
      callback(status);
    ipcRenderer.on("mcp:status", handler);
    return () => ipcRenderer.removeListener("mcp:status", handler);
  },
});
```

### 6.3 Main（IPC と制御）

**IPC チャネル定義**:

| チャネル            | 方向          | 引数                   | 戻り値                           | 説明            |
| ------------------- | ------------- | ---------------------- | -------------------------------- | --------------- |
| `chat:send`         | Renderer→Main | `userText: string`     | `ChatResponse`                   | チャット送信    |
| `chat:list`         | Renderer→Main | なし                   | `ChatTurn[]`                     | 履歴取得        |
| `chat:clear`        | Renderer→Main | なし                   | `void`                           | 履歴クリア      |
| `app:status`        | Renderer→Main | なし                   | `AppStatus`                      | アプリ状態取得  |
| `mcp:status`        | Main→Renderer | `status: string`       | なし                             | MCP接続状態通知 |
| `settings:get`      | Renderer→Main | なし                   | `PublicAppSettings`（機密は空文字列・フラグ） | 設定取得        |
| `settings:set`      | Renderer→Main | `Partial<AppSettings>` | `void`                           | 設定保存        |
| `settings:test-api` | Renderer→Main | なし                   | `{ success, error? }`            | API接続テスト   |
| `settings:test-mcp` | Renderer→Main | なし                   | `{ success, error? }`            | MCP接続テスト   |
| `chat:cancel`       | Renderer→Main | なし                   | `void`                           | 送信中止        |

**IPC チャネル検証**（Zod）:

```ts
// shared/types/ipc.ts
import { z } from "zod";
export const IpcSchemas = {
  "chat:send": {
    args: z.string().min(1).max(4000),
    result: ChatResponseSchema,
  },
  "settings:set": { args: AppSettingsPartialSchema, result: z.void() },
};
```

Main プロセス側で `ipcMain.handle` のハンドラ内でスキーマ検証を行い、不正な引数は `AppError` として処理する。

**グローバルエラーハンドラ**（Main プロセス）:

```ts
process.on("uncaughtException", (error) => {
  logger.error("Uncaught:", error);
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection:", reason);
});
```

### 6.4 Chat Service

**役割**: 質問分類・資料検索・プロンプト合成・LLM呼び出しの統括

**並行リクエスト制御（mutex）**:

```ts
// src/main/chat-service.ts
private sendLock = new Mutex(); // async-mutex 等

async sendChat(userText: string): Promise<ChatResponse> {
  const release = await this.sendLock.acquire();
  try {
    return await this._sendChatInternal(userText);
  } finally {
    release();
  }
}
```

送信中（`isLoading === true`）は Renderer 側で UI を無効化し（F11）、Main 側では mutex で二重送信を防止する二重ガード構成。

**トークン予算管理**:

```ts
const MAX_CONTEXT_TOKENS = 4000; // 概算
function truncateHistory(messages: ChatTurn[], budget: number): ChatTurn[] {
  // 最新の会話から budget に収まる分のみを返す
}
```

履歴（`ChatTurn[]`）は API の `messages` 配列に含めて送信する。トークン予算を超過する場合は古い会話から順に切り詰める。

**処理フロー**:

```text
sendChat(userText)
  │
  ├─1. RetrievalOrchestrator.search(userText)
  │     ├─ MCP Client: MOOCs 資料検索
  │     └─ （推奨）Search Client: 検索エンジンスクレイピング
  │
  ├─2. PromptComposer.compose(userText, searchResults)
  │     └─ システムプロンプト + ユーザ質問 + 検索結果 を合成
  │
  ├─3. IniadApiClient.chat(composedPrompt)
  │     └─ INIAD API で推論
  │
  ├─4. ResponseComposer.compose(llmResponse, searchResults)
  │     └─ 回答テキスト + 参照元抽出
  │
  └─5. ChatResponse を返却
```

### 6.5 MCP Client（INIAD-MOOCs-MCP）

**役割**: INIAD-MOOCs-MCP サーバとの通信

**MCP サーバ**: [`@rarandeyo/iniad-moocs-mcp`](https://github.com/rarandeyo/INIAD-MOOCs-MCP)（v0.0.5-beta.3、Apache-2.0）
Playwright ベースで INIAD MOOCs に自動ログイン・講義情報取得を行う MCP サーバ。

**通信方式**: stdio（`npx` 経由で子プロセスとして自動起動）

**組み込み方式**: アプリケーションの `package.json` に `@rarandeyo/iniad-moocs-mcp` を依存追加し、`npx` ではなく直接 `require.resolve` でエントリポイントを解決して起動する。これによりユーザ個別のグローバルインストールが不要となる。

> **前提**: INIAD MOOCs のブラウザ自動操作に Playwright（Chromium）を使用するため、初回起動前に `npx playwright install chromium` が必要。インストーラまたは初回起動ガイドで案内する。

```ts
// 実装イメージ
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// 組み込まれた MCP サーバのエントリポイントを解決
const mcpServerPath = require.resolve("@rarandeyo/iniad-moocs-mcp");

// 設定画面から取得した認証情報を環境変数として渡す
const transport = new StdioClientTransport({
  command: "node",
  args: [mcpServerPath, "--headless"],
  env: {
    ...process.env,
    INIAD_USERNAME: settings.moocsUsername,
    INIAD_PASSWORD: settings.moocsPassword,
  },
});

const client = new Client({ name: "iniad-chat", version: "1.0.0" });
await client.connect(transport);
```

**MCP ツール一覧**（`@rarandeyo/iniad-moocs-mcp` が提供）:

| ツール名                            | 引数     | 戻り値               | 説明                                           |
| ----------------------------------- | -------- | -------------------- | ---------------------------------------------- |
| `loginToIniadMoocsWithIniadAccount` | なし     | `CourseSummary[]`    | INIAD アカウントでログインし、コース一覧を返す |
| `listCourses`                       | なし     | `CourseSummary[]`    | コース一覧取得                                 |
| `listLectureLinks`                  | なし     | `LectureLink[]`      | 講義回一覧取得                                 |
| `listSlideLinks`                    | なし     | `SlideLink[]`        | スライド一覧取得                               |
| `submit_assignment`                 | （各種） | （結果）             | 課題提出（MVPでは使用しない）                  |
| `browser_navigate`                  | `url`    | （結果）             | ページ遷移（汎用）                             |
| `browser_snapshot`                  | なし     | （スナップショット） | ページスナップショット（汎用）                 |

> **MVP での利用方針**: ユーザの質問に対して、`loginToIniadMoocsWithIniadAccount` → `listCourses` → `listLectureLinks` → `listSlideLinks` のフローで関連講義資料を取得する。`submit_assignment` は MVP スコープ外。

**検索ロジックフロー**:

```text
1. MCP Client.search(query)
     ├─ 成功 → 結果をチャットコンテキストに含める
     └─ 失敗/タイムアウト → フォールバック（プレーン回答）

2. （推奨の場合）Search Client.search(query)
     ├─ 成功 → 結果を補足情報として追加
     └─ 失敗 → MCP 結果のみで回答

3. 結果なし → 「参考資料が見つかりませんでした」を明示してプレーン回答
```

**ライフサイクル管理**:

- アプリ起動時に `client.connect(transport)` を実行
- 設定変更時に `client.close()` → 再接続
- アプリ終了時に `client.close()` を `app.on('before-quit')` で確実に実行
- 接続状態は `mcp:status` イベントで Renderer に通知

**レスポンスキャッシュ**:

- 同一クエリに対する検索結果を簡易キャッシュ（`Map<string, SearchResult>`）
- TTL: 5分（設定変更可能）
- MVP ではメモリ上のみ、永続化なし

**タイムアウト**:

- MCP ツール呼び出し: **30秒**（Playwright のページロード待ちを考慮）
- API リクエスト: 30秒
- 全体のチャット応答: 60秒（検索 + LLM の合計）

**エラー分類**:

| エラー種別                         | 処理                                   |
| ---------------------------------- | -------------------------------------- |
| MCP サーバ起動失敗                 | フォールバック（プレーン会話）に移行   |
| Playwright 未インストール          | 設定画面に案内を表示                   |
| 認証エラー（ユーザ名/パスワード）  | 設定画面で「MOOCs認証に失敗」と表示    |
| ツール呼び出しタイムアウト（10秒） | 検索結果なしとして扱い、フォールバック |
| 検索結果0件                        | 検索結果なしとしてプレーン回答         |

### 6.6 INIAD API Client

**役割**: INIAD API（OpenAI 互換）との通信

INIAD が契約している OpenAI API を利用するための API で、学生は INIAD 活動関連の範囲であれば**無料**で利用可能（コストは発生するため無駄遣いは禁止）。

**提供機能**: Chat Completion API、Embeddings API、Text Completion API、Models API、Moderations API

> **注意**: `Text Completion` の `prompt` は `string` 型のみ、`Embeddings` の `input` は `string` 型のみ対応。
> `image_url` の `detail` は必ず `high` または `low` を明示的に指定すること（`auto` は `high` 相当のトークン消費となる）。

**認証方式**: Bearer Token 認証。APIキーは INIAD Slack の「GPT-4o mini」ボットに `apikey issue` と入力して発行。

```ts
// INIAD API エンドポイント
// POST https://api.openai.iniad.org/api/v1/chat/completions
//
// Headers:
//   Authorization: Bearer <発行したAPIキー>
//   Content-Type: application/json
//
// Body: OpenAI Chat Completions API 互換
```

**設定**:

| パラメータ   | 値                                    | 備考                                 |
| ------------ | ------------------------------------- | ------------------------------------ |
| `baseURL`    | `https://api.openai.iniad.org/api/v1` | 設定画面で変更可能                   |
| `model`      | `gpt-5.4-nano`                        | デフォルトモデル、設定画面で変更可能 |
| `timeout`    | 30000ms                               | 30秒                                 |
| `maxRetries` | 2                                     | リトライ回数                         |

> **APIキー・設定の読み込み**: APIキー、ベースURL、モデル名はすべて `SettingsStore`（§6.7）から読み込む。`.env` は初回起動時のフォールバックのみに使用。

**LLM レスポンス検証**:

```ts
// Chat Completions レスポンスの必須フィールド検証
function validateApiResponse(data: unknown): ChatCompletionResponse {
  if (!data || typeof data !== "object")
    throw new AppError("INVALID_RESPONSE", "Empty API response");
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.choices) || obj.choices.length === 0) {
    throw new AppError("INVALID_RESPONSE", "No choices in API response");
  }
  const message = obj.choices[0].message;
  if (!message?.content)
    throw new AppError("INVALID_RESPONSE", "Empty message content");
  return data as ChatCompletionResponse;
}
```

APIからの空レスポンスや予期しない構造は `AppError("INVALID_RESPONSE")` として扱い、フォールバックまたはエラー表示に遷移する。

### 6.7 SettingsStore（設定永続化）

**役割**: ユーザ設定の安全な保存・読み込み・変更通知

**保存先**: `app.getPath('userData')/settings.json`（Electron のユーザデータディレクトリ）

**デフォルト値の読み込み順序**:

1. `settings.json`（ユーザが設定画面で保存した値）
2. `.env`（初回起動時のフォールバック、設定保存後は使用しない）
3. ハードコードされたデフォルト値

```ts
// src/main/settings-store.ts の実装イメージ
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

const SETTINGS_FILE = "settings.json";

export class SettingsStore {
  private filePath: string;
  private settings: AppSettings;

  constructor() {
    this.filePath = path.join(app.getPath("userData"), SETTINGS_FILE);
    this.settings = this.load();
  }

  /** 設定取得（機密値は空文字列・設定��みフラグで示す） */
  getSettings(): PublicAppSettings {
    return {
      apiKey: "",
      baseURL: this.settings.baseURL,
      model: this.settings.model,
      moocsUsername: this.settings.moocsUsername,
      moocsPassword: "",
      hasApiKey: this.settings.apiKey.length > 0,
      hasMoocsCredentials:
        this.settings.moocsUsername.length > 0 && this.settings.moocsPassword.length > 0,
    };
  }

  /** 設定保存（部分更新対応） */
  set(partial: Partial<AppSettings>): void {
    // 空文字列の場合は既存値を維持（未編集時の誤上書き防止）
    this.settings = {
      ...this.settings,
      ...Object.fromEntries(
        Object.entries(partial).filter(([_, v]) => v !== ""),
      ),
    };
    this.save();
  }

  /** ファイルへ保存 */
  private save(): void {
    fs.writeFileSync(
      this.filePath,
      JSON.stringify(this.settings, null, 2),
      "utf-8",
    );
  }

  /** ファイルから読み込み */
  private load(): AppSettings {
    const defaults = this.getDefaults();
    if (fs.existsSync(this.filePath)) {
      const saved = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      return { ...defaults, ...saved };
    }
    return defaults;
  }

  /** デフォルト値（.env をフォールバックとして使用） */
  private getDefaults(): AppSettings {
    return {
      apiKey: process.env.OPENAI_API_KEY ?? "",
      baseUrl:
        process.env.OPENAI_BASE_URL ?? "https://api.openai.iniad.org/api/v1",
      model: "gpt-5.4-nano",
      moocsUsername: process.env.INIAD_USERNAME ?? "",
      moocsPassword: process.env.INIAD_PASSWORD ?? "",
    };
  }
}
```

**設定項目一覧**:

| 設定キー        | 型       | デフォルト値                          | 説明                         |
| --------------- | -------- | ------------------------------------- | ---------------------------- |
| `apiKey`        | `string` | `.env` の `OPENAI_API_KEY`            | INIAD API キー（Renderer には送信しない） |
| `baseUrl`       | `string` | `https://api.openai.iniad.org/api/v1` | API ベース URL               |
| `model`         | `string` | `gpt-5.4-nano`                        | デフォルトモデル             |
| `moocsUsername` | `string` | `.env` の `INIAD_USERNAME`            | INIAD MOOCs ユーザ名         |
| `moocsPassword` | `string` | `.env` の `INIAD_PASSWORD`            | INIAD MOOCs パスワード       |

**セキュリティ**:

- `settings.json` は OS のユーザデータディレクトリに保存（他ユーザからはアクセス不可）
- APIキー・パスワードは Renderer へ値を���信せず設定済みフラグのみ送信
- 空文字列入力時は既存値を維持（未編集時の誤上書き防止）

**機密情報の暗号化（safeStorage）**:

```ts
import { safeStorage } from "electron";

// 保存時: 機密情報（apiKey/moocsPassword）を1つの JSON にまとめて暗号化
// 同期 API（isEncryptionAvailable/encryptString/decryptString）は Electron 46 で削除されるため非同期 API を使う
const secrets = JSON.stringify({ apiKey, moocsPassword });
if (await safeStorage.isAsyncEncryptionAvailable()) {
  const encrypted = await safeStorage.encryptStringAsync(secrets);
  // 一時ファイルに書いてから rename で置き換える（途中で失敗しても元のファイルが残る）
  await writeFileAtomic(credentialsPath, encrypted.toString("base64"));
}

// 読込時: 復号して JSON をパース
// shouldReEncrypt が true でも起動時には書き直さず、次にユーザーが保存したときに新しい鍵で暗号化する
const encrypted = Buffer.from(
  await fs.readFile(credentialsPath, "utf-8"),
  "base64",
);
const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted);
const secrets = JSON.parse(result);
```

同期 API で保存済みの `credentials.enc`（`v10` プレフィックス）は `decryptStringAsync` でそのまま復号できる。Linux で `getSelectedStorageBackend()` が `basic_text` の場合は安全な保存先とみなさず、資格情報を保存しない。

APIキーと MOOCs パスワードは `settings.json` に平文保存せず、Electron の `safeStorage` API で暗号化して `credentials.enc` に別途保存する。`settings.json` ��は機密情報以外の設定値のみを格納する。

**脅威モデルの注意**: safeStorage（Windows は DPAPI、macOS は Keychain）はディスク上の平文露出を防ぐが、同一ユーザー権限で動くマルウェアやログイン中の物理アクセスからは完全には保護しない（OS 資格情報で復号可能）。真の保護には OS ユーザーアカウント保護・ディスク暗号化（BitLocker/FileVault）の併用が必要。

**平文フォールバック**: safeStorage が利用不可（Linux の一部環境等）の場合は、credentials.enc に平文 JSON（`plaintext:` プレフィックス付き base64）でフ���ールバック保存し、コンソールで警告する。Windows/macOS では常に暗号化される。

**ファイル破損リカバリ**:

```ts
private load(): AppSettings {
  const defaults = this.getDefaults();
  try {
    if (fs.existsSync(this.filePath)) {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const saved = JSON.parse(raw);
      return { ...defaults, ...saved };
    }
  } catch (error) {
    logger.warn("Settings file corrupted, restoring defaults:", error);
    // 破損ファイルをバックアップ
    fs.renameSync(this.filePath, this.filePath + ".bak");
  }
  return defaults;
}
```

**ファイル権限**:

- `settings.json` と `credentials.enc` は作成時に `0600`（オーナー読み書きのみ）を設定
- Windows 環境では適宜 ACL で保護

### 6.8 Search Client（検索エンジンスクレイピング）

**役割**: `google-sr` ライブラリによる Google 検索結果のスクレイピング

```ts
// 実装イメージ（google-sr 使用）
import { search, type TextResult } from "google-sr";

export class SearchClient {
  /**
   * Google 検索を実行し、構造化された結果を返す
   * @param query 検索クエリ
   * @param maxResults 最大取得件数
   */
  async search(query: string, maxResults: number = 3): Promise<SearchResult[]> {
    try {
      const results = await search({ query });
      return results
        .filter((r): r is TextResult => r.type === "search")
        .slice(0, maxResults)
        .map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description ?? "",
        }));
    } catch (error) {
      console.error("Search scraping failed:", error);
      return [];
    }
  }
}
```

**使用ライブラリ**: `google-sr`

| 特徴             | 説明                                                  |
| ---------------- | ----------------------------------------------------- |
| APIキー          | 不要                                                  |
| 対応検索エンジン | Google                                                |
| 戻り値           | タイトル・URL・スニペットの構造化データ               |
| TypeScript対応   | ネイティブ対応（型定義内包）                          |
| 代替ライブラリ   | `duck-duck-scrape`（DuckDuckGo スクレイピングの場合） |

> **注意**: スクレイピングは検索エンジンの利用規約に抵触する可能性がある。
> 教育目的での利用に留め、本運用時は公式API（Serper.dev 等）への移行を検討すること。

**レート制限**:

- 連続リクエストを防ぐため、同一セッション内で **10秒間の最小間隔** を設定
- クライアント側で直近の検索時刻を記録し、間隔内のリクエストはスキップ

**入力サニタイズ**:

```ts
function sanitizeQuery(query: string): string {
  return query
    .replace(/[<>"'&]/g, "") // HTML特殊文字除去
    .slice(0, 200); // 長さ制限
}
```

**URL 検証**:

```ts
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}
```

検索結果の `url` は `isValidUrl` で検証し、不正なURLは結果から除外する。

## 7. データ設計

### 7.1 データ型定義

```ts
// src/shared/types/

// --- errors.ts ---

/** アプリ共通エラー型 */
export class AppError extends Error {
  constructor(
    public readonly code: string, // "MCP_CONNECTION_FAILED" | "API_AUTH_ERROR" | "INVALID_RESPONSE" | ...
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// --- chat.ts ---

/** チャット1ターン */
export interface ChatTurn {
  id: string; // UUID
  userText: string; // ユーザ入力テキスト
  answerText: string; // AI回答テキスト
  citations: Citation[]; // 参照元情報
  createdAt: string; // ISO8601 タイムスタンプ
  latencyMs: number; // 処理時間（ms）
  fallbackUsed: boolean; // フォールバック使用フラグ
}

/** 参照元情報 */
export interface Citation {
  title: string; // 資料タイトル
  sourceType: "moocs" | "web"; // 取得元種別
  url: string; // 資料URL（必須）
  snippet?: string; // 関連部分の抜粋
}

/** チャットAPI レスポンス */
export interface ChatResponse {
  answerText: string; // 生成回答
  citations: Citation[]; // 参照元配列
  meta: {
    model: string;
    latencyMs: number;
    fallbackUsed: boolean;
    searchResultsCount: number; // 検索結果件数
    tokenUsage?: { prompt: number; completion: number }; // トークン使用量（API対応時）
  };
}

// --- search.ts ---

/** 検索結果（スクレイピング） */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** MCP（MOOCs）検索結果 */
export interface MoocsResult {
  courseName: string;
  lectureTitle: string;
  slideTitle?: string;
  slideUrl?: string;
  snippet?: string;
}

// --- settings.ts ---

/** アプリ状態 */
export interface AppStatus {
  mcpStatus: "connected" | "disconnected" | "connecting"; // MCP接続状態
  model: string; // 現在のモデル名
  historyCount: number; // 会話履歴数
}

/** アプリ設定 */
export interface AppSettings {
  apiKey: string; // INIAD API キー
  baseUrl: string; // API ベース URL
  model: string; // デフォルトモデル
  moocsUsername: string; // INIAD MOOCs ユーザ名
  moocsPassword: string; // INIAD MOOCs パスワード
}
```

### 7.2 環境変数

> **注意**: `.env` は初回起動時のフォールバックのみに使用。設定画面（§6.1）で保存した値が `settings.json`（§6.7）に永続化され、以降はそちらが優先される。

```bash
# .env.example
# ※ 初回起動時のフォールバック用。設定画面で保存後は不要。
# APIキーは INIAD Slack「GPT-4o mini」ボットで "apikey issue" を実行して取得
OPENAI_API_KEY=your-api-key-here
OPENAI_BASE_URL=https://api.openai.iniad.org/api/v1
```

## 8. 処理フロー（詳細）

**コンテキスト管理**: API の `messages` 配列には直近の会話履歴（`ChatTurn[]`）を含めて送信する。トークン予算（`MAX_CONTEXT_TOKENS`）を超過する場合は古い会話から順に切り詰める。

```ts
// messages 配列の構築イメージ
const messages = [
  { role: "system", content: systemPrompt },
  ...truncateHistory(chatHistory, tokenBudget).flatMap((t) => [
    { role: "user", content: t.userText },
    { role: "assistant", content: t.answerText },
  ]),
  { role: "user", content: currentUserText },
];
```

**検索結果のマッチング・フィルタリング**:

- MCP から取得したコース一覧をユーザ質問のキーワードでフィルタリング
- 関連度スコアリングは MVP ではキーワード一致数による簡易評価
- 上位3件をコンテキストに含める

### 8.1 通常フロー（MCP連携あり）

```text
1. ユーザがテキストを入力し「送信」をクリック
2. Renderer → preload → Main: chat:send IPC
3. ChatService.sendChat(userText) 起動
4. RetrievalOrchestrator.search(userText)
   a. MCP Client に検索依頼
   b. 検索結果（MoocsResult[]）を取得
5. PromptComposer.compose(userText, searchResults)
   a. システムプロンプト生成
   b. 検索結果をコンテキストとして埋め込み
   c. ユーザ質問を付与
6. IniadApiClient.chat(composedPrompt)
   a. INIAD API にリクエスト送信
   b. レスポンス取得
7. ResponseComposer.compose(llmResponse, searchResults)
   a. 回答テキスト抽出
   b. 参照元情報と関連付けて Citation 配列生成
8. ChatResponse を IPC で Renderer に返却
9. Renderer が回答と参照元を表示
```

### 8.2 フォールバックフロー（MCP連携なし）

```text
1-3. 通常フローと同じ
4. RetrievalOrchestrator.search(userText)
   a. MCP Client がタイムアウトまたはエラー
   b. searchResults = []（空配列）
5. PromptComposer.compose(userText, [])
   a. 検索結果なしのプレーンプロンプトを生成
6-9. 通常フローと同じ（fallbackUsed = true）
```

## 9. プロンプト設計

### 9.1 システムプロンプト（MCP連携あり）

```text
あなたは INIAD（東洋大学 情報連携学部）の学習支援AIアシスタントです。
以下の参照資料に基づいて、学生の質問に答えてください。

【参照資料】
{searchResults}

【回答ルール】
- 参照資料に基づいて回答してください
- 参照資料に情報がない場合は、「提供された資料に該当情報がありません」と明示してください
- 推測で答える場合は「推測ですが」と前置きしてください
- 関連する講義資料があれば、参照元を示してください
- 参照元を回答文中に [REF:1], [REF:2] の形式で記述し、対応する資料を明確にしてください
```

**トークン予算管理**: システムプロンプト + 検索結果 + 履歴 + ユーザ質問の合計が `MAX_CONTEXT_TOKENS`（概算4000）を超過しないよう、検索結果の件数や履歴ターン数を調整する。

### 9.2 システムプロンプト（フォールバック時）

```text
あなたは INIAD（東洋大学 情報連携学部）の学習支援AIアシスタントです。
学生の質問に丁寧に答えてください。

現在、講義資料へのアクセスができません。一般知識に基づいて回答しますが、
INIAD の講義内容とは異なる場合があることをご了承ください。
```

## 10. エラーハンドリング方針

| エラー種別                | ユーザ表示                                                                     | 内部処理                                           |
| ------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| MCP 接続失敗              | 「講義資料連携なしモードで回答します」                                         | フォールバック、`fallbackUsed=true`                |
| MCP 検索タイムアウト      | 「講義資料の検索に失敗しました」                                               | 検索結果なしとして継続                             |
| MCP 認証エラー            | 「MOOCs認証に失敗しました。設定画面でユーザ名・パスワードを確認してください」  | エラー返却                                         |
| Playwright 未インストール | 「ブラウザコンポーネントが未インストールです。設定画面の案内に従ってください」 | エラー返却                                         |
| INIAD API 認証エラー      | 「API認証に失敗しました。設定画面でAPIキーを確認してください」                 | エラー返却、再試行なし                             |
| INIAD API タイムアウト    | 「回答の生成に時間がかかっています。再試行してください」                       | 30秒で打ち切り                                     |
| INIAD API レート制限      | 「しばらく待ってから再試行してください」                                       | エラー返却                                         |
| ネットワークエラー        | 「ネットワークに接続できません」                                               | エラー返却                                         |
| 設定ファイル破損          | 「設定をデフォルトに戻しました」                                               | 破損ファイルを .bak に退避、デフォルト復元         |
| LLM 空レスポンス          | 「回答の生成に失敗しました。再試行してください」                               | `AppError("INVALID_RESPONSE")` を送出              |
| グローバル未ハンドル例外  | （クラッシュ防止）                                                             | `process.on("uncaughtException")` でログ記録・継続 |

## 11. セキュリティ・運用

| 項目                       | 方針                                                                            | 優先度 |
| -------------------------- | ------------------------------------------------------------------------------- | ------ |
| APIキー管理                | `settings.json` で管理（ユーザデータディレクトリ）、`.gitignore` でコミット禁止 | 必須   |
| 機密情報暗号化             | `safeStorage` API で APIキー・パスワードを暗号化（`credentials.enc` に保存）    | 必須   |
| パスワード管理             | MOOCsパスワードも暗号化保存、Renderer には値を送信せず設定済みフラグのみ        | 必須   |
| Renderer 分離              | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`             | 必須   |
| CSP                        | `index.html` の meta タグで外部スクリプト・インラインスクリプトを制限           | 必須   |
| IPC 検証                   | Zod スキーマで IPC チャネルの引数・戻り値を検証                                 | 必須   |
| 入力サニタイズ             | ユーザ入力・検索クエリの HTML 特殊文字をエスケープ                              | 必須   |
| URL 検証                   | 検索結果・Citation の URL を `new URL()` で検証                                 | 必須   |
| 設定ファイル権限           | OS のユーザデータディレクトリに保存、`0600` で保護                              | 必須   |
| ログ出力                   | 質問本文・APIキー・パスワードの長期保存禁止、最小限のメタ情報のみ               | 必須   |
| 依存関係監査               | `npm audit` を CI に組み込む                                                    | 必須   |
| 取得規約                   | INIAD MOOCs / API の利用規約に準拠                                              | 必須   |
| Playwright セキュリティ    | ヘッドレスモードで起動、ユーザの目視操作なし                                    | 必須   |
| プロンプトインジェクション | システムプロンプトをユーザが上書きできない構造にする                            | 必須   |
| サンドボックス             | BrowserWindow の `sandbox: true` を有効化                                       | 必須   |

## 12. 今後拡張

| 拡張内容                  | 概要                                 | 影響範囲                       |
| ------------------------- | ------------------------------------ | ------------------------------ |
| Web検索スクレイピング強化 | Google 以外の検索エンジン対応        | `search-client.ts` 拡張        |
| 引用ハイライト            | 回答テキスト中の引用部分をハイライト | `renderer/` コンポーネント拡張 |
| 会話履歴永続化            | IndexedDB / ファイル保存             | `ChatService` 拡張             |
| ストリーミング応答        | SSE による段階的回答表示             | IPC・UI 大幅改修               |

> **ストリーミング IPC 注記**: ストリーミング対応時は `ipcMain.handle`（リクエスト・レスポンス型）から `webContents.send`（イベント駆動型）への移行が必要。Renderer 側は `onChunk` イベントリスナで部分受信し、`onComplete` で完了通知を受け取る設計に変更する。
> | 課題提出機能 | MCP `submit_assignment` ツールの活用 | ChatService・UI 拡張 |
> | ブラウザリソース最適化 | Playwright を CDP で Electron 内蔵 Chromium に接続し、Chromium プロセスを1つに統合 | `mcp-client.ts` 改修・Playwright 起動オプション変更 |

## 13. 受け入れ基準（MVP）

| ID   | 基準                                                    | 確認方法                                         |
| ---- | ------------------------------------------------------- | ------------------------------------------------ |
| AC01 | MOOCs 連携ON時、INIAD講義の質問に参照元付きで回答される | INIAD講義トピックで質問し、Citation が表示される |
| AC02 | MOOCs 連携OFF時、プレーン会話が成立する                 | MCP停止状態でチャット送信                        |
| AC03 | APIキーが Renderer 側に露出しない                       | DevTools で `process.env` にAPIキーが含まれない  |
| AC04 | 基本質問シナリオでクラッシュしない                      | 10回連続で異なる質問を送信                       |
| AC05 | MCP 接続失敗時にフォールバックメッセージが表示される    | MCPサーバを起動せずにチャット送信                |
| AC06 | API エラー時に再試行導線が表示される                    | 無効なAPIトークンでチャット送信                  |
| AC07 | 設定画面からAPIキー・モデル・MOOCs認証を保存できる      | 設定画面で値を入力し保存後、再起動で反映確認     |
| AC08 | 設定画面でAPIキーが空欄・設定済み表示になる             | 設定画面を開き、APIキー欄が空欄・設定済みヒントであることを確認 |
| AC09 | API接続テストが設定画面から実行できる                   | 有効なAPIキーで「API接続テスト」ボタン押下       |
| AC10 | MCP接続テストが設定画面から実行できる                   | MOOCs認証情報入力後に「MCP接続テスト」ボタン押下 |
| AC11 | MCP連携時のエンドツーエンド応答が10秒以内               | `latencyMs` ログで計測・検証                     |
| AC12 | すべてのエラーが `AppError` として統一的に処理される    | エラー発生時のスタックトレースで AppError 確認   |
| AC13 | 極端に長い入力（4000文字以上）でクラッシュしない        | 最大長のテキストを送信                           |
| AC14 | 特殊文字（<script>等）を含む入力でクラッシュしない      | XSS ペイロード風テキストを送信                   |
| AC15 | 連続高速送信（10回/秒）でクラッシュしない               | UI 無効化・mutex が機能することを確認            |

## 14. テスト戦略

**テストフレームワーク**: Vitest

| レイヤー          | テスト種別         | 対象                                              | カバレッジ目標 |
| ----------------- | ------------------ | ------------------------------------------------- | -------------- |
| `shared/types/`   | ユニット           | Zod スキーマ検証、型ガード                        | 90%            |
| `main/services/`  | ユニット           | ChatService、SettingsStore、SearchClient          | 80%            |
| `main/mcp-client` | ユニット           | MCP Client のモック通信                           | 80%            |
| `main/ipc/`       | ユニット           | IPC ハンドラのスキーマ検証・エラー処理            | 80%            |
| Main 統合         | インテグレーション | IPC → Service → API のEnd-to-End（モックAPI使用） | 70%            |
| Electron E2E      | E2E                | Spectron / Playwright によるシナリオテスト        | 主要パス       |

**テスト実行コマンド**:

```bash
# ユニットテスト
npm run test

# カバレッジレポート
npm run test:coverage

# E2E テスト
npm run test:e2e
```

**CI/CD での自動実行**: プルリクエスト時に `npm run test:coverage` を実行し、カバレッジ低下を検知する。

## 15. ロギング戦略

**ログレベル**:

| レベル  | 出力先                | 内容                                       |
| ------- | --------------------- | ------------------------------------------ |
| `error` | ファイル + コンソール | `AppError` のスタックトレース、API エラー  |
| `warn`  | ファイル + コンソール | フォールバック発生、設定ファイル破損回復   |
| `info`  | ファイル              | 起動/終了、MCP接続状態変更、設定保存       |
| `debug` | コンソール（開発時）  | IPC メッセージ、検索クエリ、API レスポンス |

**機密情報の取り扱い**:

- APIキー、MOOCsパスワード、ユーザの質問本文はログに**出力しない**
- エラー時は `code` のみ記録し、`message` に機密情報が含まれる場合はマスク処理

**ログローテーション**:

- `app.getPath('userData')/logs/` に日付別ファイルで保存
- 7日以上古いログは自動削除
