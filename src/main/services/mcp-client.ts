import { Client } from "@modelcontextprotocol/sdk/client/index";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import fs from "fs";
import { createHash, randomUUID } from "crypto";
import { createRequire } from "module";
import os from "os";
import path from "path";
import { z } from "zod";
import { AppError, type ErrorCode } from "../../shared/types/errors";
import type { CourseSummary, LectureLink, SlideLink } from "../../shared/types/search";
import type { McpStatus } from "../../shared/types/settings";

const TOOL_TIMEOUT_MS = 45_000;
const MAX_TOOL_TIMEOUT_MS = 90_000;
const GOOGLE_LOGIN_TIMEOUT_MS = 90_000;
const CONNECT_TIMEOUT_MS = 30_000;
const PING_TIMEOUT_MS = 5_000;
const TOOL_LIST_TIMEOUT_MS = 5_000;
const LOGIN_TOOL_TIMEOUT_MS = 90_000;
/**
 * ログインに成功してから、ログインを省略してよい時間。
 * MOOCs 側でセッションが切れていても、この時間が過ぎれば次の moocs_login で入り直す。
 */
const MOOCS_SESSION_REUSE_MS = 20 * 60_000;
/** 裏のログインが失敗したあと、次に裏で試すまでの間隔。 */
const BACKGROUND_LOGIN_RETRY_MS = 2 * 60_000;
const MAX_TOOL_LIST_PAGES = 10;
const MAX_MOOCS_URL_CHARS = 2_048;
const MCP_RUNTIME_MANIFEST = "runtime.json";
const MCP_RUNTIME_INTEGRITY_FILE = "integrity.json";
const MAX_RUNTIME_FILES = 20_000;
const MAX_RUNTIME_BYTES = 2 * 1024 * 1024 * 1024;
const MCP_PROFILE_PREFIX = "iniad-ai-chat-mcp-";

declare const __MCP_RUNTIME_TREE_SHA256__: string;

const mcpRuntimeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    nodeExecutable: z.string().min(1).max(1_024),
    entryScript: z.string().min(1).max(1_024),
    mcpCli: z.string().min(1).max(1_024),
    chromiumExecutable: z.string().min(1).max(1_024),
  })
  .strict();

interface McpRuntime {
  nodeExecutable: string;
  entryScript: string;
  mcpCli: string;
  chromiumExecutable: string;
}

/**
 * このアプリが利用を許可する MCP ツールの完全な一覧。
 * Renderer や LLM から渡された名前を、そのまま MCP サーバーへ転送しない。
 */
export const REQUIRED_MCP_TOOLS = [
  "loginToIniadMoocsWithIniadAccount",
  "listCourses",
  "browser_navigate",
  "listLectureLinks",
  "listSlideLinks",
  "browser_snapshot",
  "loginToGoogleWithIniadAccount",
  "expandSlideTab",
  "extractGoogleSlideText",
] as const;

type AllowedMcpTool = (typeof REQUIRED_MCP_TOOLS)[number];

const ALLOWED_MCP_TOOLS = new Set<string>(REQUIRED_MCP_TOOLS);
const NO_ARGUMENT_TOOLS = new Set<AllowedMcpTool>([
  "loginToIniadMoocsWithIniadAccount",
  "listCourses",
  "listLectureLinks",
  "listSlideLinks",
  "browser_snapshot",
  "loginToGoogleWithIniadAccount",
  "expandSlideTab",
  "extractGoogleSlideText",
]);

/** MCP 子プロセスに引き継いでよい、実行に必要な環境変数だけを列挙する。 */
const MCP_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "XDG_CACHE_HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
  "LANG",
  "LC_ALL",
  "TZ",
] as const;

export type McpFailureKind =
  | "authentication"
  | "playwright"
  | "timeout"
  | "transient"
  | "configuration"
  | "cancelled"
  | "unknown";

/** 接続マネージャーが再試行可否を安全に判断できる、サニタイズ済みエラー。 */
export class McpClientError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    readonly kind: McpFailureKind,
    readonly guidance: string,
    readonly retryable: boolean
  ) {
    super(code, message);
    this.name = "McpClientError";
  }
}

/** process.env 全量を第三者プロセスへ渡さないための境界。 */
export function buildMcpChildEnvironment(
  source: NodeJS.ProcessEnv,
  username: string,
  password: string
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MCP_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  env.INIAD_USERNAME = username;
  env.INIAD_PASSWORD = password;
  return env;
}

/** Resolve only the Node process that launched a non-Electron development/test command. */
export function resolveNodeExecutable(): string {
  if (!process.versions.electron && /^(?:node|node\.exe)$/i.test(path.basename(process.execPath))) {
    try {
      const resolved = fs.realpathSync(process.execPath);
      if (fs.statSync(resolved).isFile() && /^(?:node|node\.exe)$/i.test(path.basename(resolved))) {
        return resolved;
      }
    } catch {
      // Fall through to the configuration error below.
    }
  }

  throw new McpClientError(
    "MCP_CONNECTION_FAILED",
    "MCP の実行に必要な Node.js が見つかりません。",
    "configuration",
    "開発環境を再構築してください。配布版では同梱された固定ランタイムを使用します。",
    false
  );
}

function runtimeConfigurationError(): McpClientError {
  return new McpClientError(
    "MCP_CONNECTION_FAILED",
    "MCP の安全な実行環境が見つかりません。",
    "configuration",
    "アプリを再インストールしてください。開発環境では Chromium を導入してから再起動してください。",
    false
  );
}

function resolveRuntimeFile(runtimeRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw runtimeConfigurationError();

  try {
    const realRoot = fs.realpathSync(runtimeRoot);
    const candidate = path.resolve(realRoot, relativePath);
    const realCandidate = fs.realpathSync(candidate);
    const relative = path.relative(realRoot, realCandidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw runtimeConfigurationError();
    }
    if (!fs.statSync(realCandidate).isFile()) throw runtimeConfigurationError();
    return realCandidate;
  } catch (error) {
    if (error instanceof McpClientError) throw error;
    throw runtimeConfigurationError();
  }
}

function getEmbeddedRuntimeTreeHash(): string | undefined {
  if (
    typeof __MCP_RUNTIME_TREE_SHA256__ === "string" &&
    /^[a-f0-9]{64}$/.test(__MCP_RUNTIME_TREE_SHA256__)
  ) {
    return __MCP_RUNTIME_TREE_SHA256__;
  }
  return undefined;
}

async function computeRuntimeTreeHash(runtimeRoot: string): Promise<string> {
  const realRoot = await fs.promises.realpath(runtimeRoot);
  const hash = createHash("sha256");
  let fileCount = 0;
  let totalBytes = 0;

  const visit = async (directory: string): Promise<void> => {
    const entries = (await fs.promises.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(realRoot, absolutePath).replaceAll(path.sep, "/");
      if (relativePath === MCP_RUNTIME_INTEGRITY_FILE) continue;

      const metadata = await fs.promises.lstat(absolutePath);
      if (metadata.isSymbolicLink()) throw runtimeConfigurationError();
      if (metadata.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!metadata.isFile()) throw runtimeConfigurationError();

      fileCount += 1;
      totalBytes += metadata.size;
      if (fileCount > MAX_RUNTIME_FILES || totalBytes > MAX_RUNTIME_BYTES) {
        throw runtimeConfigurationError();
      }

      hash.update("file\0");
      hash.update(relativePath);
      hash.update("\0");
      hash.update(String(metadata.size));
      hash.update("\0");
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(absolutePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      hash.update("\0");
    }
  };

  await visit(realRoot);
  return hash.digest("hex");
}

async function verifyRuntimeIntegrity(runtimeRoot: string): Promise<void> {
  if (!process.versions.electron) return;
  const expected = getEmbeddedRuntimeTreeHash();
  if (!expected) throw runtimeConfigurationError();

  const realRoot = fs.realpathSync(runtimeRoot);
  try {
    const actual = await computeRuntimeTreeHash(realRoot);
    if (actual !== expected) throw runtimeConfigurationError();
  } catch (error) {
    if (error instanceof McpClientError) throw error;
    throw runtimeConfigurationError();
  }
}

async function loadMcpRuntime(runtimeRoot: string): Promise<McpRuntime> {
  try {
    const manifestPath = path.join(runtimeRoot, MCP_RUNTIME_MANIFEST);
    const parsed = mcpRuntimeManifestSchema.safeParse(
      JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    );
    if (!parsed.success) throw runtimeConfigurationError();

    const runtime = {
      nodeExecutable: resolveRuntimeFile(runtimeRoot, parsed.data.nodeExecutable),
      entryScript: resolveRuntimeFile(runtimeRoot, parsed.data.entryScript),
      mcpCli: resolveRuntimeFile(runtimeRoot, parsed.data.mcpCli),
      chromiumExecutable: resolveRuntimeFile(runtimeRoot, parsed.data.chromiumExecutable),
    };
    // Verify immediately before returning executable paths to the spawn call.
    await verifyRuntimeIntegrity(runtimeRoot);
    return runtime;
  } catch (error) {
    if (error instanceof McpClientError) throw error;
    throw runtimeConfigurationError();
  }
}

async function resolveMcpRuntime(): Promise<McpRuntime> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const packagedRuntime = path.join(resourcesPath, ".mcp-runtime");
    if (fs.existsSync(path.join(packagedRuntime, MCP_RUNTIME_MANIFEST))) {
      return loadMcpRuntime(packagedRuntime);
    }
  }

  if (/[\\/]app\.asar[\\/]/.test(__filename)) {
    throw runtimeConfigurationError();
  }

  const moduleRequire = createRequire(__filename);
  const pkgDir = path.dirname(moduleRequire.resolve("@rarandeyo/iniad-moocs-mcp/package.json"));
  let nodeModulesDir = pkgDir;
  while (
    nodeModulesDir !== path.dirname(nodeModulesDir) &&
    path.basename(nodeModulesDir) !== "node_modules"
  ) {
    nodeModulesDir = path.dirname(nodeModulesDir);
  }

  if (path.basename(nodeModulesDir) !== "node_modules") {
    throw runtimeConfigurationError();
  }

  if (process.versions.electron) {
    const generatedRuntime = path.join(path.dirname(nodeModulesDir), ".mcp-runtime");
    if (fs.existsSync(path.join(generatedRuntime, MCP_RUNTIME_MANIFEST))) {
      return loadMcpRuntime(generatedRuntime);
    }
    throw runtimeConfigurationError();
  }

  const projectRoot = path.dirname(nodeModulesDir);
  const playwright = moduleRequire("playwright") as {
    chromium: { executablePath(): string };
  };
  const chromiumExecutable = fs.realpathSync(playwright.chromium.executablePath());
  return {
    nodeExecutable: resolveNodeExecutable(),
    entryScript: fs.realpathSync(path.join(projectRoot, "scripts", "mcp-runtime-entry.cjs")),
    mcpCli: fs.realpathSync(path.join(pkgDir, "cli.js")),
    chromiumExecutable,
  };
}

/** ツール名と引数を固定 allowlist に照らし、MCPへ渡してよい形だけを返す。 */
export function validateMcpToolCall(
  toolName: string,
  args?: Record<string, unknown>
): { name: AllowedMcpTool; arguments?: Record<string, unknown> } {
  if (!ALLOWED_MCP_TOOLS.has(toolName)) {
    throw new AppError("PERMISSION_DENIED", "許可されていない MCP ツールです。");
  }

  const name = toolName as AllowedMcpTool;
  if (NO_ARGUMENT_TOOLS.has(name)) {
    if (args !== undefined && (!isPlainRecord(args) || Object.keys(args).length > 0)) {
      throw new AppError("INVALID_INPUT", "MCP ツールの引数が不正です。");
    }
    return { name, arguments: args === undefined ? undefined : {} };
  }

  if (name === "browser_navigate") {
    if (!isPlainRecord(args) || Object.keys(args).length !== 1 || typeof args.url !== "string") {
      throw new AppError("INVALID_INPUT", "MCP ナビゲーション引数が不正です。");
    }

    const rawUrl = args.url.trim();
    if (
      rawUrl.length === 0 ||
      rawUrl.length > MAX_MOOCS_URL_CHARS ||
      [...rawUrl].some((character) => {
        const codePoint = character.charCodeAt(0);
        return codePoint <= 0x1f || codePoint === 0x7f;
      })
    ) {
      throw new AppError("INVALID_INPUT", "MCP ナビゲーション URL が不正です。");
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new AppError("INVALID_INPUT", "MCP ナビゲーション URL が不正です。");
    }

    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "moocs.iniad.org" ||
      (parsed.port !== "" && parsed.port !== "443") ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw new AppError("PERMISSION_DENIED", "MOOCs 以外の URL への移動は許可されていません。");
    }

    return { name, arguments: { url: rawUrl } };
  }

  // AllowedMcpTool を追加したのに validator を追加し忘れた場合も default deny。
  throw new AppError("PERMISSION_DENIED", "MCP ツールの検証規則がありません。");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export class McpClient {
  private status: McpStatus = "disconnected";
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connectInFlight: Promise<void> | null = null;
  private connectAbortController: AbortController | null = null;
  private browserProfileDirectory: string | null = null;
  private readonly connectionIssueListeners = new Set<(error: McpClientError) => void>();
  /** 子プロセスを作り直すたびに増やす。古い接続で終わったログインを新しい接続に持ち込まない。 */
  private connectionGeneration = 0;
  /**
   * 進行中のログイン。ブラウザのタブは 1 つなので、ログインは同時に 1 回だけにする。
   * background は、質問と関係なく裏で始めたログインか（失敗しても状態を変えない）。
   */
  private loginInFlight: { promise: Promise<unknown>; background: boolean } | null = null;
  /** この接続で成功したログインの結果（コース一覧）。 */
  private moocsSession: { result: unknown; loggedInAt: number } | null = null;
  /** 裏のログインが最後に失敗した時刻。失敗が続くときに、質問のたびに試さないため。 */
  private backgroundLoginFailedAt: number | null = null;

  getStatus(): McpStatus {
    return this.status;
  }

  /**
   * 接続後の transport 切断や認証切れを Main の状態管理へ通知する。
   * Renderer に Client やツール実行権限を公開するものではない。
   */
  onConnectionIssue(listener: (error: McpClientError) => void): () => void {
    this.connectionIssueListeners.add(listener);
    return () => this.connectionIssueListeners.delete(listener);
  }

  /** 初期接続時に確認済みの子プロセスが、MCP ping に応答するか確認する。 */
  async ping(signal?: AbortSignal): Promise<boolean> {
    if (!this.client || this.status !== "connected") return false;

    try {
      await this.client.ping({
        timeout: PING_TIMEOUT_MS,
        maxTotalTimeout: PING_TIMEOUT_MS,
        signal,
      });
      if (signal?.aborted) return false;
      return true;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return false;
      const classified = this.classifyError(error);
      this.status = classified.retryable ? "disconnected" : "error";
      await this.cleanupResources();
      this.emitConnectionIssue(classified);
      return false;
    }
  }

  isConnectionError(error: unknown): boolean {
    if (error instanceof McpClientError) {
      return error.kind === "transient" || error.kind === "timeout";
    }
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return [
      "not initialized",
      "not connected",
      "connection closed",
      "econnreset",
      "econnrefused",
      "enetwork",
      "enetunreach",
      "ehostunreach",
      "eai_again",
      "epipe",
      "socket closed",
    ].some((marker) => message.includes(marker));
  }

  async connect(username: string, password: string, signal?: AbortSignal): Promise<void> {
    if (this.status === "connected") return;
    if (this.connectInFlight) return this.connectInFlight;

    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      username.trim().length === 0 ||
      password.length === 0 ||
      username.length > 320 ||
      password.length > 4_096
    ) {
      throw new McpClientError(
        "MCP_AUTH_FAILED",
        "MOOCs 認証情報が設定されていないか、形式が不正です。",
        "authentication",
        "設定画面で学籍番号とパスワードを確認し、再入力してください。",
        false
      );
    }

    const operation = this.connectInternal(username.trim(), password, signal);
    this.connectInFlight = operation;
    void operation.then(
      () => {
        if (this.connectInFlight === operation) this.connectInFlight = null;
      },
      () => {
        if (this.connectInFlight === operation) this.connectInFlight = null;
      }
    );
    return operation;
  }

  private async connectInternal(
    username: string,
    password: string,
    callerSignal?: AbortSignal
  ): Promise<void> {
    this.status = "connecting";
    const controller = new AbortController();
    this.connectAbortController = controller;
    const abortFromCaller = () => controller.abort(callerSignal?.reason);

    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      if (controller.signal.aborted) throw cancelledError();

      // 認証エラー等で transport が残った状態からの手動再接続にも安全に対応する。
      await this.cleanupResources();

      const runtime = await resolveMcpRuntime();
      const childEnvironment = buildMcpChildEnvironment(process.env, username, password);
      const browserProfileDirectory = path.join(
        os.tmpdir(),
        `${MCP_PROFILE_PREFIX}${process.pid}-${randomUUID()}`
      );
      this.browserProfileDirectory = browserProfileDirectory;

      this.transport = new StdioClientTransport({
        command: runtime.nodeExecutable,
        args: [
          runtime.entryScript,
          runtime.mcpCli,
          "--headless",
          "--browser",
          "chromium",
          "--executable-path",
          runtime.chromiumExecutable,
          "--user-data-dir",
          browserProfileDirectory,
        ],
        env: childEnvironment,
        stderr: "ignore",
      });
      this.client = new Client({ name: "iniad-ai-chat", version: "1.0.0" }, { capabilities: {} });
      this.client.onclose = () => {
        if (this.status !== "connected") return;
        this.status = "disconnected";
        this.emitConnectionIssue(
          new McpClientError(
            "MCP_CONNECTION_FAILED",
            "MCP サーバーとの接続が切断されました。",
            "transient",
            "自動再接続を試行します。改善しない場合はネットワークを確認してください。",
            true
          )
        );
      };

      await this.client.connect(this.transport, {
        timeout: CONNECT_TIMEOUT_MS,
        maxTotalTimeout: CONNECT_TIMEOUT_MS,
        signal: controller.signal,
      });

      // initialize handshake の成功だけでは接続済みにしない。
      await this.assertRequiredToolsAvailable(controller.signal);
      this.status = "connected";
    } catch (error) {
      this.status = controller.signal.aborted ? "disconnected" : "error";
      await this.cleanupResources();
      throw controller.signal.aborted ? cancelledError() : this.classifyError(error);
    } finally {
      callerSignal?.removeEventListener("abort", abortFromCaller);
      if (this.connectAbortController === controller) this.connectAbortController = null;
    }
  }

  async disconnect(): Promise<void> {
    this.connectAbortController?.abort();
    this.status = "disconnected";
    await this.cleanupResources();
  }

  // ── ツール呼び出し ──────────────────────────────

  async callToolSafe(
    toolName: string,
    args?: Record<string, unknown>,
    timeoutMs = TOOL_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<unknown> {
    // 裏で進むログインと同じタブを同時に操作しないよう、終わるまで待つ。
    // ログインの成否はここでは問わない（失敗なら状態の更新は callToolUnlocked 側で済んでいる）。
    const pendingLogin = this.loginInFlight;
    if (pendingLogin) {
      await raceWithSignal(
        pendingLogin.promise.catch(() => undefined),
        signal
      );
    }
    return this.callToolUnlocked(toolName, args, timeoutMs, signal);
  }

  /**
   * @param softFailure true のとき、失敗しても接続の状態を変えず、片付けや通知もしない。
   *   質問と関係なく裏で行うログイン用。本当の失敗は、利用者が操作したときの呼び出しで扱う。
   */
  private async callToolUnlocked(
    toolName: string,
    args?: Record<string, unknown>,
    timeoutMs = TOOL_TIMEOUT_MS,
    signal?: AbortSignal,
    softFailure = false
  ): Promise<unknown> {
    if (!this.client || this.status !== "connected") {
      throw new McpClientError(
        "MCP_CONNECTION_FAILED",
        "MCP に接続されていません。",
        "transient",
        "MCP を再接続してから、もう一度お試しください。",
        true
      );
    }
    if (signal?.aborted) throw cancelledError();

    const validated = validateMcpToolCall(toolName, args);
    const boundedTimeout = normalizeToolTimeout(timeoutMs);
    const generation = this.connectionGeneration;

    try {
      const requestOptions = {
        timeout: boundedTimeout,
        maxTotalTimeout: boundedTimeout,
        signal,
      };
      // iniad-moocs-mcp 0.0.4 returns schemas that the current SDK rejects.
      // Send exactly one protocol request after our own allowlist/schema checks;
      // retrying callTool() after response validation could execute a tool twice.
      const result: unknown = await this.client.request(
        {
          method: "tools/call",
          params: { name: validated.name, arguments: validated.arguments ?? {} },
        },
        z
          .object({
            content: z.array(z.unknown()).optional(),
            isError: z.boolean().optional(),
          })
          .passthrough(),
        requestOptions
      );
      this.handleToolResultIssue(result);
      return result;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw cancelledError();

      const classified = this.classifyError(error);
      // 切断や再接続のあとで失敗した古い呼び出し（裏のログインなど）は、新しい接続の
      // 状態を書き換えたり片付けたりしない。
      if (softFailure || generation !== this.connectionGeneration) throw classified;
      if (
        classified.retryable ||
        classified.kind === "authentication" ||
        classified.kind === "playwright"
      ) {
        this.status = classified.retryable ? "disconnected" : "error";
        await this.cleanupResources();
        this.emitConnectionIssue(classified);
      }
      throw classified;
    }
  }

  /**
   * MOOCs に実際にログインし、結果（コース一覧）を返す。
   *
   * 同時に呼ばれた場合は、進行中のログインの結果を共有する。ログイン自体は呼び出し元の
   * signal では止めない（チャットを取り消しても、終わったログインは次の質問で使える）。
   * 取り消された呼び出し元だけが、待つのをやめる。
   */
  async loginToMoocs(signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw cancelledError();
    const inFlight = this.loginInFlight;
    if (inFlight?.background) {
      // 裏のログインに相乗りする。裏のログインは失敗しても状態を変えないので、
      // 失敗したらこの呼び出しでやり直し、認証エラーなどを画面に届ける。
      try {
        return await raceWithSignal(inFlight.promise, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      const next = this.loginInFlight;
      return raceWithSignal(
        next && !next.background ? next.promise : this.startLogin(false),
        signal
      );
    }
    return raceWithSignal(inFlight ? inFlight.promise : this.startLogin(false), signal);
  }

  /**
   * ログイン済みならその結果を返し、まだなら（または時間が経っていれば）ログインする。
   * 2 問目以降の質問で、毎回ログインし直す時間を省く。
   */
  async ensureMoocsLogin(signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw cancelledError();
    const remembered = this.rememberedLogin();
    if (remembered !== undefined) return remembered;
    return this.loginToMoocs(signal);
  }

  /**
   * 質問を待たずに、裏で MOOCs へログインしておく。例外は投げない。
   *
   * 失敗しても接続の状態は変えない（MOOCs を使わない質問で接続を切ったり、遅い SSO を
   * パスワード違いと表示したりしないため）。失敗した直後は、しばらく試さない。
   * ログイン済み（または覚えている）なら true。
   */
  async prewarmMoocsLogin(): Promise<boolean> {
    if (this.status !== "connected") return false;
    if (this.rememberedLogin() !== undefined) return true;
    if (
      this.backgroundLoginFailedAt !== null &&
      Date.now() - this.backgroundLoginFailedAt < BACKGROUND_LOGIN_RETRY_MS
    ) {
      return false;
    }
    try {
      const result = await (this.loginInFlight?.promise ?? this.startLogin(true));
      return this.parseToolResult<CourseSummary>(result).length > 0;
    } catch {
      return false;
    }
  }

  private rememberedLogin(): unknown {
    const session = this.moocsSession;
    if (
      session &&
      this.status === "connected" &&
      Date.now() - session.loggedInAt < MOOCS_SESSION_REUSE_MS
    ) {
      return session.result;
    }
    return undefined;
  }

  private startLogin(background: boolean): Promise<unknown> {
    const generation = this.connectionGeneration;
    const isCurrentConnection = () => generation === this.connectionGeneration;
    const operation = this.callToolUnlocked(
      "loginToIniadMoocsWithIniadAccount",
      undefined,
      LOGIN_TOOL_TIMEOUT_MS,
      undefined,
      background
    ).then(
      (result) => {
        if (isCurrentConnection()) {
          // 最新のログインの結果で、覚えておく状態を決める。コースが 0 件のときは、
          // ログイン画面を抜けられなかった可能性があるので、前の成功も含めて忘れる。
          const loggedIn =
            this.status === "connected" && this.parseToolResult<CourseSummary>(result).length > 0;
          this.moocsSession = loggedIn ? { result, loggedInAt: Date.now() } : null;
          if (loggedIn) this.backgroundLoginFailedAt = null;
          else if (background) this.backgroundLoginFailedAt = Date.now();
        }
        return result;
      },
      (error: unknown) => {
        if (isCurrentConnection()) {
          this.moocsSession = null;
          if (background) this.backgroundLoginFailedAt = Date.now();
        }
        throw error;
      }
    );
    const entry = { promise: operation, background };
    this.loginInFlight = entry;
    const clear = () => {
      if (this.loginInFlight === entry) this.loginInFlight = null;
    };
    void operation.then(clear, clear);
    return operation;
  }

  /**
   * MOOCs に実際にログインできることを確認する。
   *
   * connect() は MCP サーバーの起動とツール一覧の確認だけで、パスワードは検証しない。
   * ログインツールはログイン画面を経由できなかった場合に、エラーではなく空のコース一覧を
   * 返すことがあるので、コースが 1 件以上取得できたときだけ成功とする。
   */
  async verifyMoocsLogin(signal?: AbortSignal): Promise<void> {
    const result = await this.loginToMoocs(signal);
    if (this.parseToolResult<CourseSummary>(result).length === 0) {
      throw new McpClientError(
        "MCP_AUTH_FAILED",
        "MOOCs へのログインを確認できませんでした。",
        "authentication",
        "学籍番号とパスワードを確認してください。正しい場合は、少し待ってからもう一度お試しください。",
        false
      );
    }
  }

  async fetchCourses(signal?: AbortSignal): Promise<CourseSummary[]> {
    const result = await this.callToolSafe("listCourses", undefined, TOOL_TIMEOUT_MS, signal);
    return this.parseToolResult<CourseSummary>(result);
  }

  async navigateTo(url: string, signal?: AbortSignal): Promise<void> {
    await this.callToolSafe("browser_navigate", { url }, TOOL_TIMEOUT_MS, signal);
  }

  async fetchLectureLinks(signal?: AbortSignal): Promise<LectureLink[]> {
    const result = await this.callToolSafe("listLectureLinks", undefined, TOOL_TIMEOUT_MS, signal);
    return this.parseToolResult<LectureLink>(result);
  }

  async fetchSlideLinks(signal?: AbortSignal): Promise<SlideLink[]> {
    const result = await this.callToolSafe("listSlideLinks", undefined, TOOL_TIMEOUT_MS, signal);
    return this.parseToolResult<SlideLink>(result);
  }

  /** 現在のページのアクセシビリティスナップショット（テキスト）を取得する。 */
  async loginToGoogle(signal?: AbortSignal): Promise<void> {
    await this.callToolSafe(
      "loginToGoogleWithIniadAccount",
      undefined,
      GOOGLE_LOGIN_TIMEOUT_MS,
      signal
    );
  }

  async expandSlideTab(signal?: AbortSignal): Promise<void> {
    await this.callToolSafe("expandSlideTab", undefined, TOOL_TIMEOUT_MS, signal);
  }

  async extractGoogleSlideText(signal?: AbortSignal): Promise<unknown> {
    return this.callToolSafe("extractGoogleSlideText", undefined, MAX_TOOL_TIMEOUT_MS, signal);
  }

  async getPageSnapshot(signal?: AbortSignal): Promise<string | null> {
    const result = await this.callToolSafe("browser_snapshot", undefined, TOOL_TIMEOUT_MS, signal);
    const typedResult = result as { content?: Array<{ type: string; text?: string }> } | undefined;
    if (!typedResult?.content) return null;
    for (const item of typedResult.content) {
      if (item.type === "text" && item.text) {
        return item.text;
      }
    }
    return null;
  }

  parseToolResult<T>(result: unknown): T[] {
    if (!result || typeof result !== "object") return [];

    const typedResult = result as {
      content?: Array<{ type: string; text?: string }>;
    };

    if (!typedResult.content || !Array.isArray(typedResult.content)) return [];

    for (const item of typedResult.content) {
      if (item.type === "text" && item.text) {
        try {
          const parsed = JSON.parse(item.text);

          if (Array.isArray(parsed)) return parsed as T[];

          if (parsed && typeof parsed === "object") {
            for (const value of Object.values(parsed)) {
              if (Array.isArray(value)) return value as T[];
            }
          }
        } catch {
          continue;
        }
      }
    }

    return [];
  }

  // ── 接続確認・エラー分類 ──────────────────────────

  private async assertRequiredToolsAvailable(signal?: AbortSignal): Promise<void> {
    if (!this.client) {
      throw new McpClientError(
        "MCP_CONNECTION_FAILED",
        "MCP クライアントが初期化されていません。",
        "transient",
        "MCP を再接続してください。",
        true
      );
    }

    const available = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
      if (signal?.aborted) throw cancelledError();
      const result = await this.listToolsPage(cursor, signal);

      if (!Array.isArray(result.tools)) {
        throw new McpClientError(
          "INVALID_RESPONSE",
          "MCP サーバーのツール一覧が不正です。",
          "configuration",
          "MCP サーバーを更新または再インストールしてください。",
          false
        );
      }
      for (const tool of result.tools) {
        if (tool && typeof tool.name === "string") available.add(tool.name);
      }

      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (!cursor) break;
      if (page === MAX_TOOL_LIST_PAGES - 1) {
        throw new McpClientError(
          "INVALID_RESPONSE",
          "MCP サーバーのツール一覧が大きすぎます。",
          "configuration",
          "MCP サーバーの設定を確認してください。",
          false
        );
      }
    }

    const missing = REQUIRED_MCP_TOOLS.filter((tool) => !available.has(tool));
    if (missing.length > 0) {
      throw new McpClientError(
        "MCP_TOOLS_UNAVAILABLE",
        `MCP サーバーに必要なツールがありません: ${missing.join(", ")}`,
        "configuration",
        "MCP サーバーを更新または再インストールしてください。",
        false
      );
    }
  }

  private async listToolsPage(
    cursor: string | undefined,
    signal?: AbortSignal
  ): Promise<{ tools: Array<{ name: string }>; nextCursor?: string }> {
    if (!this.client) {
      throw new AppError("MCP_CONNECTION_FAILED", "MCP クライアントが初期化されていません。");
    }
    const params = cursor ? { cursor } : {};
    const requestOptions = {
      timeout: TOOL_LIST_TIMEOUT_MS,
      maxTotalTimeout: TOOL_LIST_TIMEOUT_MS,
      signal,
    };
    return this.client.request(
      { method: "tools/list", params },
      z
        .object({
          tools: z.array(z.object({ name: z.string() }).passthrough()),
          nextCursor: z.string().optional(),
        })
        .passthrough(),
      requestOptions
    );
  }

  private classifyError(error: unknown): McpClientError {
    if (error instanceof McpClientError) return error;

    if (error instanceof AppError) {
      return new McpClientError(
        error.code,
        error.message,
        error.code === "CHAT_CANCELLED" ? "cancelled" : "unknown",
        error.code === "CHAT_CANCELLED"
          ? "必要であれば、もう一度接続してください。"
          : "MCP の設定を確認して、もう一度お試しください。",
        false
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();

    if (isAbortError(error)) return cancelledError();

    // ログインツールはページ移動の失敗も "Login failed: ..." で返す。回線の問題を
    // 認証失敗として扱うと、正しいパスワードの再入力を促し、自動再接続も止まってしまう。
    if (
      normalized.includes("login failed") &&
      (normalized.includes("net::err_") || normalized.includes("page.goto:"))
    ) {
      return new McpClientError(
        "MCP_CONNECTION_FAILED",
        "MOOCs に接続できませんでした。",
        "transient",
        "ネットワーク状態を確認して、もう一度お試しください。",
        true
      );
    }

    if (
      [
        "unauthorized",
        "forbidden",
        "authentication failed",
        "invalid credential",
        "login failed",
        "http 401",
        "http 403",
        "認証に失敗",
        "パスワードが正しく",
      ].some((marker) => normalized.includes(marker))
    ) {
      return new McpClientError(
        "MCP_AUTH_FAILED",
        "MOOCs の認証に失敗しました。",
        "authentication",
        "設定画面で学籍番号とパスワードを再入力してください。",
        false
      );
    }

    if (
      [
        "playwright",
        "browsertype.launch",
        "browser executable",
        "executable doesn't exist",
        "executable does not exist",
        "chromium executable",
      ].some((marker) => normalized.includes(marker))
    ) {
      return new McpClientError(
        "PLAYWRIGHT_NOT_INSTALLED",
        "MCP のブラウザー実行環境が見つかりません。",
        "playwright",
        "アプリを再インストールしてください。開発環境では `npm exec playwright install chromium` を実行して再起動してください。",
        false
      );
    }

    if (
      normalized.includes("timed out") ||
      normalized.includes("timeout") ||
      normalized.includes("etimedout") ||
      normalized.includes("requesttimeout")
    ) {
      return new McpClientError(
        "MCP_TIMEOUT",
        "MCP サーバーへの接続またはツール実行がタイムアウトしました。",
        "timeout",
        "ネットワーク状態を確認してください。自動再接続も試行されます。",
        true
      );
    }

    if (this.isConnectionError(error)) {
      return new McpClientError(
        "MCP_CONNECTION_FAILED",
        "MCP サーバーとの接続が一時的に失われました。",
        "transient",
        "ネットワーク状態を確認してください。自動再接続も試行されます。",
        true
      );
    }

    if (
      normalized.includes("enoent") ||
      normalized.includes("spawn") ||
      normalized.includes("module not found") ||
      normalized.includes("cannot find module")
    ) {
      return new McpClientError(
        "MCP_CONNECTION_FAILED",
        "MCP サーバーを起動できませんでした。",
        "configuration",
        "アプリを再インストールしてください。開発環境では依存パッケージを再構築してください。",
        false
      );
    }

    return new McpClientError(
      "MCP_CONNECTION_FAILED",
      "MCP サーバーへの接続に失敗しました。",
      "unknown",
      "MCP の設定とネットワーク状態を確認して、もう一度お試しください。",
      false
    );
  }

  private handleToolResultIssue(result: unknown): void {
    if (
      !result ||
      typeof result !== "object" ||
      !("isError" in result) ||
      result.isError !== true
    ) {
      return;
    }

    const content = "content" in result && Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter(
        (item): item is { type: string; text: string } =>
          !!item &&
          typeof item === "object" &&
          "type" in item &&
          item.type === "text" &&
          "text" in item &&
          typeof item.text === "string"
      )
      .map((item) => item.text)
      .join("\n");

    const classified = this.classifyError(new Error(text));
    if (
      classified.kind !== "authentication" &&
      classified.kind !== "playwright" &&
      classified.kind !== "timeout" &&
      classified.kind !== "transient"
    ) {
      throw new McpClientError(
        "MCP_CONNECTION_FAILED",
        "MCP ツールの実行に失敗しました。",
        "unknown",
        "操作をやり直してください。繰り返し失敗する場合は MCP を再接続してください。",
        false
      );
    }
    // Raw MCP error text may contain credentials or personal data. Throw only the
    // classified, sanitized error; callToolSafe performs state cleanup and notification.
    throw classified;
  }

  private emitConnectionIssue(error: McpClientError): void {
    for (const listener of this.connectionIssueListeners) {
      try {
        listener(error);
      } catch {
        // 状態通知先の失敗で MCP クリーンアップを妨げない。
      }
    }
  }

  // ── クリーンアップ ──────────────────────────────

  private async cleanupResources(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    const browserProfileDirectory = this.browserProfileDirectory;
    this.client = null;
    this.transport = null;
    this.browserProfileDirectory = null;
    // ブラウザごと消えるので、ログイン状態も捨てる。進行中のログインも古い接続のものなので、
    // 次の接続のログインがそれを共有しないようにする（古い方は client を閉じると失敗する）。
    this.connectionGeneration += 1;
    this.moocsSession = null;
    this.loginInFlight = null;
    this.backgroundLoginFailedAt = null;

    try {
      await client?.close();
    } catch {
      // クリーンアップエラーは秘密情報を含み得るためログへ出さない。
    }
    try {
      await transport?.close?.();
    } catch {
      // クリーンアップエラーは秘密情報を含み得るためログへ出さない。
    }
    await removeMcpBrowserProfile(browserProfileDirectory);
  }
}

async function removeMcpBrowserProfile(profileDirectory: string | null): Promise<void> {
  if (!profileDirectory) return;
  const tempRoot = path.resolve(os.tmpdir());
  const resolvedProfile = path.resolve(profileDirectory);
  const relative = path.relative(tempRoot, resolvedProfile);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !path.basename(resolvedProfile).startsWith(MCP_PROFILE_PREFIX)
  ) {
    return;
  }
  try {
    await fs.promises.rm(resolvedProfile, { recursive: true, force: true });
  } catch {
    // A locked profile is left for the OS temporary-directory cleanup policy.
  }
}

function normalizeToolTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return TOOL_TIMEOUT_MS;
  return Math.min(MAX_TOOL_TIMEOUT_MS, Math.max(1_000, Math.trunc(timeoutMs)));
}

/** 共有の処理は止めずに、この呼び出し元だけが signal で待つのをやめられるようにする。 */
function raceWithSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR";
}

function cancelledError(): McpClientError {
  return new McpClientError(
    "CHAT_CANCELLED",
    "MCP 操作がキャンセルされました。",
    "cancelled",
    "必要であれば、もう一度接続してください。",
    false
  );
}
