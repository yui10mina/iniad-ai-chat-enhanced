/**
 * 実行の記録をファイルへ保存する TraceWriter のテスト。実際の一時フォルダへ書く。
 * 1 回の実行が 1 ファイルになること、イベント以外を書き足さないこと、
 * 書き込みに失敗しても例外にならないこと、古いファイルを消すことを確かめる。
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTraceEvent } from "../../src/main/services/agent-trace";
import { ChatAgent } from "../../src/main/services/chat-agent";
import type { McpClient } from "../../src/main/services/mcp-client";
import { TraceWriter } from "../../src/main/services/trace-writer";
import type { AppSettings } from "../../src/shared/types/settings";
import { installFakeLlm, navigateCall } from "../helpers/fake-llm";

const START_AT = Date.UTC(2026, 10, 14, 7, 30, 12, 345);

function runEvents(at: number = START_AT): AgentTraceEvent[] {
  return [
    { type: "run_start", at, historyTurns: 1, priorMaterials: 0, hasSyllabusHint: false },
    {
      type: "llm_start",
      at: at + 1,
      iteration: 1,
      maxIterations: 10,
      messageCount: 2,
      payloadChars: 900,
      toolsOffered: true,
      webSearchOffered: true,
      forcedFinal: false,
    },
    {
      type: "llm_end",
      at: at + 900,
      iteration: 1,
      durationMs: 899,
      finishReason: "stop",
      usage: { promptTokens: 120, completionTokens: 8, totalTokens: 128 },
      toolCalls: 0,
      toolCallsDiscarded: false,
      contentChars: 5,
    },
    {
      type: "run_end",
      at: at + 901,
      durationMs: 901,
      reason: "answered",
      iterations: 1,
      toolCalls: 0,
      answerChars: 5,
      citations: 0,
    },
  ];
}

async function readLines(file: string): Promise<unknown[]> {
  const text = await fs.readFile(file, "utf8");
  expect(text.endsWith("\n")).toBe(true);
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

describe("TraceWriter", () => {
  let directory: string;

  beforeEach(async () => {
    directory = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "trace-writer-")), "traces");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await fs.rm(path.dirname(directory), { recursive: true, force: true });
  });

  it("writes one run as one file, one event per line, adding nothing", async () => {
    const writer = new TraceWriter({ directory });
    const events = runEvents();

    for (const event of events) writer.sink(event);
    await writer.flush();

    const files = await fs.readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^run-20261114T073012Z-[0-9a-f]{6}\.jsonl$/);
    expect(await readLines(path.join(directory, files[0]))).toEqual(events);
  });

  it("creates the directory when it does not exist yet", async () => {
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    const writer = new TraceWriter({ directory });

    writer.sink(runEvents()[0]);
    await writer.flush();

    expect((await fs.stat(directory)).isDirectory()).toBe(true);
  });

  it("starts a new file for each run", async () => {
    const writer = new TraceWriter({ directory });

    for (const event of runEvents(START_AT)) writer.sink(event);
    for (const event of runEvents(START_AT + 60_000)) writer.sink(event);
    await writer.flush();

    const files = (await fs.readdir(directory)).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("T073012Z");
    expect(files[1]).toContain("T073112Z");
    for (const file of files) {
      expect(await readLines(path.join(directory, file))).toHaveLength(4);
    }
  });

  it("keeps a run that never reached run_end and starts fresh on the next run_start", async () => {
    const writer = new TraceWriter({ directory });
    const [start, llmStart] = runEvents(START_AT);

    writer.sink(start);
    writer.sink(llmStart);
    for (const event of runEvents(START_AT + 60_000)) writer.sink(event);
    await writer.flush();

    const files = (await fs.readdir(directory)).sort();
    expect(await readLines(path.join(directory, files[0]))).toEqual([start, llmStart]);
    expect(await readLines(path.join(directory, files[1]))).toHaveLength(4);
  });

  it("does not append a stray event to a run that already ended", async () => {
    const writer = new TraceWriter({ directory });
    const events = runEvents(START_AT);
    const stray = { ...events[1], at: START_AT + 60_000 };

    for (const event of events) writer.sink(event);
    writer.sink(stray);
    await writer.flush();

    const files = (await fs.readdir(directory)).sort();
    expect(files).toHaveLength(2);
    expect(await readLines(path.join(directory, files[0]))).toEqual(events);
    expect(await readLines(path.join(directory, files[1]))).toEqual([stray]);
  });

  it("does not block the caller: the sink returns before anything is on disk", async () => {
    const writer = new TraceWriter({ directory });

    writer.sink(runEvents()[0]);

    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await writer.flush();
    expect(await fs.readdir(directory)).toHaveLength(1);
  });

  it("does not throw when the directory cannot be created, and warns once without the path", async () => {
    // 保存先と同じ名前のファイルを置いて、フォルダを作れなくする。
    await fs.writeFile(directory, "not a directory");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writer = new TraceWriter({ directory });

    expect(() => {
      for (const event of runEvents()) writer.sink(event);
    }).not.toThrow();
    await expect(writer.flush()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain(directory);
    expect(await fs.readFile(directory, "utf8")).toBe("not a directory");
  });

  it("keeps writing later runs after a failed write", async () => {
    await fs.writeFile(directory, "not a directory");
    const writer = new TraceWriter({ directory });
    for (const event of runEvents(START_AT)) writer.sink(event);
    await writer.flush();

    await fs.rm(directory);
    for (const event of runEvents(START_AT + 60_000)) writer.sink(event);
    await writer.flush();

    expect(await fs.readdir(directory)).toHaveLength(1);
  });

  it("deletes the oldest trace files beyond the limit and nothing else", async () => {
    const writer = new TraceWriter({ directory, maxFiles: 3 });
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "notes.txt"), "keep me");
    await fs.writeFile(path.join(directory, "run-old.jsonl"), "keep me too");

    for (let run = 0; run < 5; run++) {
      for (const event of runEvents(START_AT + run * 60_000)) writer.sink(event);
    }
    await writer.flush();

    const files = (await fs.readdir(directory)).sort();
    const traces = files.filter((name) => /^run-\d{8}T/.test(name));
    expect(traces.map((name) => name.slice(4, 20))).toEqual([
      "20261114T073212Z",
      "20261114T073312Z",
      "20261114T073412Z",
    ]);
    expect(files).toContain("notes.txt");
    expect(files).toContain("run-old.jsonl");
  });

  it("writes nothing from a real run that the trace itself leaves out", async () => {
    const SECRET = "SECRET";
    const settings: AppSettings = {
      apiKey: `key-${SECRET}`,
      baseURL: "https://api.openai.iniad.org/api/v1",
      model: "gpt-test",
      moocsUsername: "",
      moocsPassword: "",
    };
    const mcp = {
      getStatus: vi.fn().mockReturnValue("connected"),
      ping: vi.fn().mockResolvedValue(true),
      navigateTo: vi.fn().mockRejectedValue(new Error(`failed ${SECRET}`)),
    } as unknown as McpClient;
    installFakeLlm((index) =>
      index === 0 ? { toolCalls: [navigateCall("call_0", 1)] } : { content: `回答 ${SECRET}` }
    );
    const writer = new TraceWriter({ directory });
    const agent = new ChatAgent(mcp, { search: vi.fn() });

    const result = await agent.chat(`質問 ${SECRET}`, settings, undefined, undefined, {
      traceSinks: [writer.sink],
    });
    await writer.flush();

    expect(result.content).toContain(SECRET);
    const [file] = await fs.readdir(directory);
    const text = await fs.readFile(path.join(directory, file), "utf8");
    expect(text.trimEnd().split("\n")).toHaveLength(8);
    expect(text).toContain('"type":"run_end"');
    expect(text).toContain("/courses/2026/TEST/1");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("質問");
    expect(text).not.toContain("回答");
  });
});
