/**
 * 実行の記録（trace）を、1 回の実行につき 1 ファイルの JSONL として保存する。
 *
 * 書き込むのは受け取ったイベントそのままで、何も足さない。イベントに本文や検索語が
 * 入らないことは agent-trace.ts が保証する。
 * 書き込みに失敗しても回答は止めない。ファイルは件数の上限を超えた分だけ古い順に消す。
 */
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { AgentTraceEvent, AgentTraceSink } from "./agent-trace";

const DEFAULT_MAX_FILES = 50;
const TRACE_FILE_PATTERN = /^run-\d{8}T\d{6}Z-[0-9a-f]{6}\.jsonl$/;

export interface TraceWriterOptions {
  /** 保存先。なければ作る。 */
  directory: string;
  /** 残すファイルの数。超えた分は古い順に消す。 */
  maxFiles?: number;
}

export class TraceWriter {
  private readonly directory: string;
  private readonly maxFiles: number;
  private currentFile: string | null = null;
  /** 書き込みを順番に行うための待ち行列。失敗しても次へ進む。 */
  private queue: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(options: TraceWriterOptions) {
    this.directory = options.directory;
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  }

  /** イベントを受け取る sink。同期的には何もせず、書き込みは待ち行列に積む。 */
  readonly sink: AgentTraceSink = (event) => {
    if (event.type === "run_start" || this.currentFile === null) {
      this.currentFile = path.join(this.directory, traceFileName(event.at));
    }
    const file = this.currentFile;
    const line = `${JSON.stringify(event)}\n`;
    const isFirstLine = event.type === "run_start";
    const isLastLine = event.type === "run_end";
    if (isLastLine) this.currentFile = null;

    this.enqueue(async () => {
      if (isFirstLine) await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await fs.appendFile(file, line, { encoding: "utf8", mode: 0o600 });
      if (isLastLine) await this.prune();
    });
  };

  /** 積んだ書き込みがすべて終わるのを待つ。失敗していても例外にしない。 */
  flush(): Promise<void> {
    return this.queue;
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch(() => {
      // 保存先の場所やエラーの内容は出さない。同じ警告を繰り返さない。
      if (!this.warned) {
        this.warned = true;
        console.warn("[TraceWriter] Failed to write a trace file; the answer is not affected");
      }
    });
  }

  /** 自分が作った形式のファイルだけを数え、上限を超えた分を古い順に消す。 */
  private async prune(): Promise<void> {
    const names = (await fs.readdir(this.directory))
      .filter((name) => TRACE_FILE_PATTERN.test(name))
      .sort();
    const excess = names.slice(0, Math.max(0, names.length - this.maxFiles));
    for (const name of excess) {
      await fs.rm(path.join(this.directory, name), { force: true });
    }
  }
}

/** run-20261114T073012Z-a1b2c3.jsonl の形。名前順が時刻順になる。 */
function traceFileName(at: AgentTraceEvent["at"]): string {
  const stamp = new Date(at)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
  return `run-${stamp}-${randomBytes(3).toString("hex")}.jsonl`;
}
