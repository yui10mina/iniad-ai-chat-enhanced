import { defineConfig } from "vitest/config";

// live 評価（実 API と実 MOOCs）用。npm run eval:live で手動実行する。
// 既定の設定（vitest.config.mts）は *.test.ts だけを対象にするので、npm test では動かない。
export default defineConfig({
  test: {
    globals: true,
    include: ["tests/eval-live/**/*.live.ts"],
    // 1 問が 1 分を超えることがあり、上限まで調べると数分かかる。
    testTimeout: 600_000,
    hookTimeout: 180_000,
    // MOOCs のブラウザーは 1 つなので、質問は順番に実行する。
    fileParallelism: false,
  },
});
