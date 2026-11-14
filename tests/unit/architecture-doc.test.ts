/**
 * docs/architecture.md に書いたパスが実在することを確かめる。
 * ファイルを移動や削除したときに、文書だけが古いまま残るのを防ぐ。
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DOC_PATH = path.join(REPO_ROOT, "docs", "architecture.md");
const doc = readFileSync(DOC_PATH, "utf8");

/** バッククォートで囲まれた、リポジトリ内のパスに見える文字列。 */
const codePaths = [
  ...new Set(
    [...doc.matchAll(/`((?:src|tests|scripts|patches|data|docs)\/[^`\s]*)`/g)].map(
      (match) => match[1]
    )
  ),
];

/** Markdown のリンクのうち、外部の URL でないもの。 */
const linkedFiles = [
  ...new Set([...doc.matchAll(/\]\((?!https?:)([^)#]+)(?:#[^)]*)?\)/g)].map((match) => match[1])),
];

describe("docs/architecture.md", () => {
  it("names paths at all, so that this test is checking something", () => {
    expect(codePaths.length).toBeGreaterThan(30);
  });

  it.each(codePaths)("refers to an existing path: %s", (repoPath) => {
    expect(existsSync(path.join(REPO_ROOT, repoPath)), repoPath).toBe(true);
  });

  it.each(linkedFiles)("links to an existing file: %s", (link) => {
    expect(existsSync(path.resolve(path.dirname(DOC_PATH), link)), link).toBe(true);
  });

  it("states the number of replay scenarios that exist", () => {
    const scenarios = readdirSync(path.join(REPO_ROOT, "tests", "fixtures", "agent-replay")).filter(
      (name) => name.endsWith(".json")
    );

    expect(doc).toContain(`${scenarios.length} つのシナリオ`);
  });

  it("is linked from the README", () => {
    expect(readFileSync(path.join(REPO_ROOT, "README.md"), "utf8")).toContain(
      "(docs/architecture.md)"
    );
  });
});
