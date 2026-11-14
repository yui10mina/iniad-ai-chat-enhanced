# live 評価

実際の INIAD API と MOOCs を使って質問を実行し、結果を採点します。合成データの replay（`tests/eval/`）とちがい、本物のモデルが動くので、回答の中身を期待値と比べられます。

- **手で実行します。** `npm test` と CI では動きません（ファイル名が `*.live.ts` のため）。
- **採点の関数だけは CI で動きます**（`scorers.test.ts`、`report.test.ts`）。

## 実行のしかた

Node.js 22.12 以上と、Playwright の Chromium（`npm exec playwright install chromium`）が必要です。

環境変数を設定してから実行します。値は自分の端末で設定し、ファイルには書かないでください。

| 変数                  | 内容                                           |
| --------------------- | ---------------------------------------------- |
| `INIAD_API_KEY`       | INIAD API のキー                               |
| `INIAD_USERNAME`      | MOOCs のユーザー名                             |
| `INIAD_PASSWORD`      | MOOCs のパスワード                             |
| `LIVE_EVAL_RUNS`      | 質問 1 件あたりの実行回数（任意、既定 1）      |
| `LIVE_EVAL_QUESTIONS` | 質問ファイルのパス（任意）                     |
| `LIVE_EVAL_ONLY`      | 実行する質問の id をカンマ区切りで指定（任意） |

```bash
npm run eval:live
```

3 つの必須の変数がそろっていないときは、何も実行せずにスキップします。

## 質問ファイル

`questions.json` を読みます。なければ `questions.example.json` を使います。

`questions.example.json` は、接続と採点が動くことを確かめるための 1 問だけです（MOOCs を調べない挨拶）。評価に使う質問は `questions.json` に書きます。

```json
[
  {
    "id": "tcp-handshake",
    "question": "（質問文）",
    "expect": {
      "tools": ["moocs_read_slide"],
      "urlPaths": ["/courses/2026/XXX000/01/01"],
      "phrases": ["（回答に入っていてほしい語句）"]
    }
  }
]
```

- `expect` は任意です。書かなくても実行でき、時間・ツール回数・トークン数などは必ず計測されます。
- `tools`：成功していてほしいツール名。
- `urlPaths`：引用に入っていてほしい URL のパス。読んだだけで引用に入らなかったものは数えません。
- `phrases`：回答に入っていてほしい語句。全角と半角、大文字と小文字、空白の違いは無視します。

## 結果

`eval-output/<日時>/` に書きます。

- `summary.md`：質問ごとの表。値は「平均（最小–最大）」です。
- `summary.json`：同じ内容と、実行ごとの点数。
- `<id>-run<n>.json`：1 回分の回答、引用、実行の記録、点数。

**`eval-output/` はコミットしないでください。** 回答文には教材の内容が含まれ、このリポジトリは公開されています。`.gitignore` に入れてあります。

## 結果の読み方

- モデルは毎回ちがう答え方をします（temperature は既定値の 1 で、変えられません）。1 回の実行だけで良し悪しを判断しないでください。
- 変更の前後を比べるときは、同じ質問ファイルと同じ実行回数で測り、平均ではなく幅の重なりを見ます。
- 点数は期待値に対する割合で、回答の正しさそのものではありません。語句が入っていても説明が誤っていることはあり得ます。
