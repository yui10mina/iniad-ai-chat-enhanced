# INIAD AI Chat Enhanced

INIAD（東洋大学 情報連携学部）の学生向けに、MOOCs 講義資料等に基づく高精度な回答ができるチャットアプリケーション。Electron + TypeScript で構築されています。

## 機能概要

- INIAD API（OpenAI 互換）を利用したチャット
- MCP 経由での MOOCs 講義資料検索・参照
- 参照元（Citation）の表示
- 設定画面（APIキー・モデル・MOOCs 認証情報）
- フォールバック（MCP 未接続時もプレーン会話可能）
- Web 検索（google-sr によるスクレイピング）

## 必要環境

| 要件    | バージョン              |
| ------- | ----------------------- |
| Node.js | 22.12 以上              |
| npm     | 9 以上                  |
| OS      | Windows / macOS / Linux |

Electron のバイナリは `npm install` では取得されず、初回の `npm start` などで自動的にダウンロードされます。このダウンロードには Node.js 22.12 以上が必要です。
`npm run package` は実行中の Node.js を配布物へ同梱するので、配布物も 22.12 以上の Node.js で作成してください。

## クイックスタート

### 1. リポジトリをクローン

```bash
git clone https://github.com/Ryosuke-Asano/iniad-ai-chat-enhanced.git
cd iniad-ai-chat-enhanced
```

### 2. 依存パッケージをインストール

```bash
npm install
npm exec playwright install chromium
```

2行目は MOOCs 参照用 MCP が使う Chromium を導入します。未導入の場合、通常のAIチャットは利用できますが、MCP接続は「接続エラー」となります。

### 3. 開発サーバーを起動

```bash
npm start
```

Electron ウィンドウが立ち上がれば成功です。

## MCP 配布ランタイム

`npm run package` は MCP 用の固定 Node.js、依存パッケージ、Playwright Chromium を
`.mcp-runtime` として配布物へ同梱します。配布されたアプリの利用者が Node.js や
Chrome を別途導入する必要はありません。開発・パッケージ作成前には、依存関係に
対応する Chromium を次のコマンドで導入してください。

```bash
npm exec playwright install chromium
```

`npm run verify:mcp:packaged` は、ホスト側ではなく配布物内の Node.js、MCP、Chromium
を使用し、配布ランタイム全体の SHA-256 照合と実際のブラウザツール起動まで検証します。
アプリ本体も MCP 子プロセスを起動する直前に同じ照合を行い、改変を検出した場合は接続を拒否します。
講義・スライド索引もASAR整合性検証対象のアプリ本体へ同梱され、配布版でも資料名と位置情報を利用できます。

## NPM Scripts

| コマンド          | 内容                           |
| ----------------- | ------------------------------ |
| `npm start`       | 開発用に Electron アプリを起動 |
| `npm run package` | 実行可能パッケージを生成       |
| `npm run make`    | インストーラー/配布物を生成    |
| `npm run lint`    | ESLint による静的検査          |
| `npm run type-check` | TypeScript の型検査             |
| `npm test`        | Vitest のテスト実行              |
| `npm run verify:mcp` | MCP・Playwright・必須ツールの診断 |
| `npm run verify:mcp:packaged` | 生成済みWindows配布物のMCP診断 |

## プロジェクト構成

```
iniad-ai-chat-enhanced/
├── docs/
│   ├── design.md         # 詳細設計書
│   ├── assignment.md     # タスク割当表
│   └── proposal.md       # 提案書
├── src/
│   ├── main/             # Main プロセス
│   │   └── index.ts      # エントリポイント（BrowserWindow生成）
│   ├── preload/          # Preload スクリプト
│   │   ├── preload.ts    # contextBridge 定義
│   │   └── index.d.ts    # Renderer 向け型宣言
│   ├── renderer/         # Renderer プロセス（React）
│   │   ├── index.html    # メインHTML
│   │   ├── index.css     # スタイル
│   │   ├── renderer.tsx  # React エントリ
│   │   └── App.tsx       # ルートコンポーネント
│   └── shared/
│       └── types/        # 共通型定義
│           ├── chat.ts   # ChatTurn, ChatResponse, Citation
│           ├── settings.ts # AppSettings, AppStatus
│           ├── search.ts # SearchResult, CacheEntry
│           ├── errors.ts # AppError, ErrorCode
│           └── index.ts  # Barrel export
├── forge.config.ts       # electron-forge 設定
├── webpack.main.config.js
├── webpack.preload.config.js
├── webpack.renderer.config.js
├── webpack.rules.js
├── webpack.plugins.js
├── tsconfig.json
└── package.json
```

## ドキュメント

- [提案書](docs/proposal.md) — プロジェクトの背景・目的・技術選定
- [詳細設計書](docs/design.md) — アーキテクチャ・API・セキュリティ設計
- [タスク割当表](docs/assignment.md) — メンバー別タスク・スケジュール

## ライセンス

MIT
