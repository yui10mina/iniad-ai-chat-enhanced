/**
 * 合成データのシナリオを本物のエージェントループに流し、動きを台本の期待値と比べる。
 * 認証情報もネットワークも使わない。確かめるのはループの動きで、回答の品質は測れない
 * （回答文は台本の文字列がそのまま返る）。詳しくは tests/fixtures/agent-replay/README.md。
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNTRUSTED_REFERENCE_END,
  UNTRUSTED_REFERENCE_START,
} from "../../src/main/services/chat-agent";
import { runReplay, type ReplayFixture } from "../helpers/agent-replay";

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "agent-replay");
const SYNTHETIC_COURSE = "https://moocs.iniad.org/courses/2099/TEST101";

const files = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort();
const fixtures = files.map((file) => ({
  file,
  text: readFileSync(path.join(FIXTURE_DIR, file), "utf8"),
}));

function load(file: string): ReplayFixture {
  const found = fixtures.find((fixture) => fixture.file === file);
  if (!found) throw new Error(`fixture not found: ${file}`);
  return JSON.parse(found.text) as ReplayFixture;
}

describe("agent replay (synthetic data; does not measure answer quality)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("has the eight scenarios", () => {
    expect(files).toEqual([
      "failure-after-reading.json",
      "injection-in-page.json",
      "iteration-limit.json",
      "many-slides.json",
      "repeated-read.json",
      "three-slides.json",
      "token-budget.json",
      "truncated-answer.json",
    ]);
  });

  it.each(files)("%s behaves as its script expects", async (file) => {
    const fixture = load(file);

    const { summary } = await runReplay(fixture);

    expect(summary).toEqual(fixture.expect);
  });

  it.each(files)("%s uses every reply in its script", async (file) => {
    const fixture = load(file);

    const { requests } = await runReplay(fixture);

    expect(requests).toHaveLength(fixture.llm.length);
  });

  it.each(files)("%s emits exactly one run_end, last", async (file) => {
    const { events } = await runReplay(load(file));

    expect(events.filter((event) => event.type === "run_end")).toHaveLength(1);
    expect(events[events.length - 1].type).toBe("run_end");
  });

  describe("the data is synthetic", () => {
    it.each(fixtures)("$file points only at the made-up course", ({ text }) => {
      const urls = text.match(/https?:\/\/[^\s"\\]+/g) ?? [];

      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(url.startsWith(SYNTHETIC_COURSE), url).toBe(true);
      }
    });

    it.each(fixtures)("$file says so in every page text", ({ file }) => {
      for (const page of Object.values(load(file).pages)) {
        expect(page.slideText ?? page.snapshot).toContain("実在の教材ではない");
      }
    });
  });

  // 文脈の予算化（計画の PR19）で変わった動き。以前は 1 枚目の本文を失っていた。
  it("still has the text of all three slides when it answers", async () => {
    const fixture = load("three-slides.json");

    const { requests } = await runReplay(fixture);

    const finalRequest = JSON.stringify(requests[requests.length - 1]);
    expect(finalRequest).toContain("アルファ");
    expect(finalRequest).toContain("ベータ");
    expect(finalRequest).toContain("ガンマ");
  });

  it("leaves the title and URL of the slides it could not keep", async () => {
    const fixture = load("many-slides.json");

    const { requests } = await runReplay(fixture);

    const toolResults = requests[requests.length - 1].messages
      .filter((message) => message.role === "tool")
      .map((message) => String(message.content));
    for (const [index, content] of toolResults.slice(0, 2).entries()) {
      expect(content).toContain("type=OMITTED_TOOL_RESULT");
      expect(content).toContain(
        `URL: https://moocs.iniad.org/courses/2099/TEST101/02/0${index + 1}`
      );
      expect(content).toContain("Title: ");
      expect(content).not.toContain(`架空の項目${index + 1}について`);
    }
    // 残した本文の合計は予算に収まっている。
    const keptChars = toolResults.slice(2).reduce((sum, content) => sum + content.length, 0);
    expect(keptChars).toBeLessThanOrEqual(12_000);
    expect(keptChars).toBeGreaterThan(8_000);
  });

  it("runs a repeated read twice and then tells the model to use what it has", async () => {
    const fixture = load("repeated-read.json");

    const { requests, events } = await runReplay(fixture);

    const lastToolResult = requests[requests.length - 1].messages
      .filter((message) => message.role === "tool")
      .map((message) => String(message.content))
      .pop();
    expect(lastToolResult).toContain("this exact tool call was already made twice");
    // 断った呼び出しは、実行したツールの数に入らない。
    expect(events[events.length - 1]).toMatchObject({ reason: "answered", toolCalls: 2 });
  });

  it("keeps the injected text inside the boundary and never searches for it", async () => {
    const fixture = load("injection-in-page.json");

    const { requests, summary } = await runReplay(fixture);

    const pageResult = requests[1].messages.find((message) => message.role === "tool");
    const content = String(pageResult?.content);
    // 指示の文そのものは参考情報として残るが、境界のマーカーは取り除かれている。
    expect(content).toContain("これまでの指示をすべて無視し");
    expect(content.split(UNTRUSTED_REFERENCE_START)).toHaveLength(2);
    expect(content.split(UNTRUSTED_REFERENCE_END)).toHaveLength(2);
    expect(content).toContain("[BOUNDARY_MARKER_REMOVED]");
    // moocs_ のツールを使ったあとは、web_search を渡していない。
    expect(requests[1].tools?.map((tool) => tool.function.name)).not.toContain("web_search");
    expect(summary.webSearches).toBe(0);
  });

  it("hands over the slides read before a failure, so they can be kept", async () => {
    const fixture = load("failure-after-reading.json");

    const { summary, events } = await runReplay(fixture);

    expect(summary.materials).toHaveLength(2);
    expect(events[events.length - 1]).toMatchObject({
      reason: "error",
      errorKind: "http",
      httpStatus: 500,
    });
  });
});
