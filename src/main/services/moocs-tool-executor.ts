import type { McpClient } from "./mcp-client";
import type { IWebSearchProvider } from "./web-search-types";
import type { SlidesIndexService } from "./slides-index";
import type { Citation } from "../../shared/types/chat";
import type { SearchResult } from "../../shared/types/search";
import type { MaterialContextInput } from "./in-memory-store";
import { MoocsPageReader, type MaterialToolExecutionResult } from "./moocs-page-reader";
import { inferMoocsLocation } from "./moocs-page-kind";
import { formatMcpResult, truncate, type ToolExecutionResult } from "./mcp-result";

const MAX_SNAPSHOT_CHARS = 3_000;
const MAX_WEB_QUERY_CHARS = 500;
const MAX_URL_CHARS = 2_048;
const MAX_WEB_RESULT_TITLE_CHARS = 200;
const MAX_WEB_RESULT_SNIPPET_CHARS = 500;

const NO_ARGUMENT_AGENT_TOOLS = new Set([
  "moocs_login",
  "moocs_list_courses",
  "moocs_list_lectures",
  "moocs_list_slides",
  "moocs_expand_slide_tab",
  "moocs_page_content",
  "moocs_google_login",
]);

/** LLM に渡さない危険な MCP ツール */
const BLOCKED_MCP_TOOLS = new Set(["submit_assignment", "browser_handle_dialog"]);

/**
 * moocs.iniad.org 上の HTTPS URL かを厳密に検証する。
 * startsWith だと `https://moocs.iniad.org.evil.example/` のような
 * ドメイン偽装を通してしまうため、URL パース結果の hostname で比較する。
 */
function isMoocsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "moocs.iniad.org" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port
    );
  } catch {
    return false;
  }
}

export interface ToolExecutionContext {
  mcpClient: McpClient;
  webClient: IWebSearchProvider;
  mcpConnected: boolean;
  slidesIndex?: SlidesIndexService;
  /** 同一チャット内の moocs_read_slide キャッシュ (url → content) */
  slideReadCache?: Map<string, string>;
  /**
   * 同一チャット内の moocs_login の状況。2 回目の moocs_login や、ほかの MOOCs ツールを
   * 使ったあとの moocs_login は、セッション切れを疑っての呼び出しなので、覚えている
   * ログイン結果を使わずに入り直す。
   */
  moocsLoginState?: { called: boolean; otherMoocsToolUsed?: boolean };
  signal?: AbortSignal;
}

export interface AgentToolExecutionResult extends ToolExecutionResult {
  materials?: MaterialContextInput[];
}

export async function executeAgentTool(
  toolName: string,
  argsJson: string,
  ctx: ToolExecutionContext
): Promise<AgentToolExecutionResult> {
  throwIfAborted(ctx.signal);
  let args: Record<string, unknown> = {};
  try {
    const parsed = argsJson ? (JSON.parse(argsJson) as unknown) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { content: "Error: tool arguments must be a JSON object", citations: [] };
    }
    args = parsed as Record<string, unknown>;
  } catch {
    return { content: "Error: tool arguments must be valid JSON", citations: [] };
  }
  const argumentError = validateAgentToolArguments(toolName, args);
  if (argumentError) return { content: `Error: ${argumentError}`, citations: [] };
  if (ctx.moocsLoginState && toolName.startsWith("moocs_") && toolName !== "moocs_login") {
    ctx.moocsLoginState.otherMoocsToolUsed = true;
  }

  const citations: Citation[] = [];
  const pageReader = new MoocsPageReader(
    ctx.mcpClient,
    ctx.slidesIndex,
    ctx.slideReadCache,
    ctx.signal
  );

  try {
    switch (toolName) {
      case "moocs_login":
        return await runMoocsTool(ctx, async () => {
          const state = ctx.moocsLoginState;
          const forceLogin = state?.called === true || state?.otherMoocsToolUsed === true;
          if (state) state.called = true;
          const result = forceLogin
            ? await ctx.mcpClient.loginToMoocs(ctx.signal)
            : await ctx.mcpClient.ensureMoocsLogin(ctx.signal);
          return formatMcpResult(result, citations);
        });

      case "moocs_list_courses":
        return await runMoocsTool(ctx, async () => {
          const result = await ctx.mcpClient.callToolSafe(
            "listCourses",
            undefined,
            undefined,
            ctx.signal
          );
          return formatMcpResult(result, citations);
        });

      case "moocs_navigate": {
        const url = args.url as string;
        if (!isMoocsUrl(url)) {
          return { content: "Error: url must be a moocs.iniad.org URL", citations: [] };
        }
        return await runMoocsTool(ctx, async () => {
          await ctx.mcpClient.navigateTo(url, ctx.signal);
          citations.push({
            title: "MOOCs ページ",
            url,
            snippet: "閲覧中のページ",
            sourceType: "moocs",
          });
          return { content: `Navigated to ${url}`, citations };
        });
      }

      case "moocs_list_lectures":
        return await runMoocsTool(ctx, async () => {
          const result = await ctx.mcpClient.callToolSafe(
            "listLectureLinks",
            undefined,
            undefined,
            ctx.signal
          );
          return formatMcpResult(result, citations);
        });

      case "moocs_list_slides":
        return await runMoocsTool(ctx, async () => {
          const result = await ctx.mcpClient.callToolSafe(
            "listSlideLinks",
            undefined,
            undefined,
            ctx.signal
          );
          return formatMcpResult(result, citations);
        });

      case "moocs_read_slide": {
        const slideUrl = args.url as string | undefined;
        if (slideUrl && !isMoocsUrl(slideUrl)) {
          return { content: "Error: url must be a moocs.iniad.org URL", citations: [] };
        }
        return await runMoocsTool(ctx, async () => pageReader.readPage(slideUrl));
      }

      case "moocs_expand_slide_tab":
        return await runMoocsTool(ctx, async () => {
          const result = await ctx.mcpClient.callToolSafe(
            "expandSlideTab",
            undefined,
            undefined,
            ctx.signal
          );
          return formatMcpResult(result, citations);
        });

      case "moocs_page_content":
        return await runMoocsTool(ctx, async () => {
          const slideAttempt = await pageReader.tryExtractSlideText(citations);
          if (slideAttempt) return slideAttempt;

          const snapshot = await ctx.mcpClient.getPageSnapshot(ctx.signal);
          if (!snapshot) {
            return { content: "Error: empty page snapshot", citations: [] };
          }
          const truncated =
            snapshot.length > MAX_SNAPSHOT_CHARS
              ? snapshot.slice(0, MAX_SNAPSHOT_CHARS) + "\n...(truncated)"
              : snapshot;
          const metadata = parseMoocsSnapshotMetadata(snapshot);
          if (!metadata) return { content: truncated, citations };

          const citation: Citation = {
            title: metadata.title,
            url: metadata.url,
            location: inferMoocsLocation(metadata.url),
            sourceType: "moocs",
          };
          citations.push(citation);
          return {
            content: truncated,
            citations,
            materials: [
              {
                title: citation.title,
                url: citation.url,
                location: citation.location,
                sourceType: "moocs",
                content: truncated,
              },
            ],
          };
        });

      case "moocs_google_login":
        return await runMoocsTool(ctx, async () => {
          const result = await ctx.mcpClient.callToolSafe(
            "loginToGoogleWithIniadAccount",
            undefined,
            90_000,
            ctx.signal
          );
          return formatMcpResult(result, citations);
        });

      case "web_search": {
        const query = (args.query as string).trim();
        const result = await withAbort(ctx.webClient.search(query), ctx.signal);
        if (!result.success) {
          return { content: `Web search failed: ${result.error ?? "unknown"}`, citations: [] };
        }
        const safeResults = result.results
          .slice(0, 5)
          .map(sanitizeWebSearchResult)
          .filter((item): item is SearchResult => item !== null);
        const lines = safeResults.map(
          (r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`
        );
        for (const r of safeResults) {
          citations.push({
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            sourceType: "web",
          });
        }
        const content = truncate(lines.join("\n\n") || "No web results");
        // Search snippets are transient discovery metadata, not fetched source
        // documents. Keep their citations for the current answer, but do not
        // retain snippets as reusable material context for later conversations.
        return { content, citations };
      }

      default:
        if (BLOCKED_MCP_TOOLS.has(toolName)) {
          return { content: `Error: tool "${toolName}" is not allowed`, citations: [] };
        }
        return { content: `Error: unknown tool "${toolName}"`, citations: [] };
    }
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { content: `Tool error: ${message}`, citations: [] };
  }
}

function sanitizeWebSearchResult(result: SearchResult): SearchResult | null {
  if (
    typeof result.title !== "string" ||
    typeof result.url !== "string" ||
    typeof result.snippet !== "string" ||
    result.url.length === 0 ||
    result.url.length > MAX_URL_CHARS
  ) {
    return null;
  }

  try {
    const parsed = new URL(result.url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    const snippet = result.snippet.trim().slice(0, MAX_WEB_RESULT_SNIPPET_CHARS);
    if (!snippet) return null;
    return {
      title: result.title.trim().slice(0, MAX_WEB_RESULT_TITLE_CHARS) || parsed.hostname,
      url:
        parsed.pathname === "/" && !parsed.search && !parsed.hash
          ? parsed.origin
          : parsed.toString(),
      snippet,
      source: "web",
      relevanceScore: result.relevanceScore,
    };
  } catch {
    return null;
  }
}

function parseMoocsSnapshotMetadata(snapshot: string): { title: string; url: string } | null {
  const url = snapshot.match(/^- Page URL:\s*(\S+)\s*$/m)?.[1];
  if (!url || url.length > MAX_URL_CHARS || !isMoocsUrl(url)) return null;

  const parsed = new URL(url);
  const rawTitle = snapshot.match(/^- Page Title:\s*(.+)\s*$/m)?.[1]?.trim();
  return {
    title: rawTitle?.slice(0, MAX_WEB_RESULT_TITLE_CHARS) || "MOOCs ページ",
    url: parsed.toString(),
  };
}

async function runMoocsTool(
  ctx: ToolExecutionContext,
  fn: () => Promise<MaterialToolExecutionResult>
): Promise<AgentToolExecutionResult> {
  throwIfAborted(ctx.signal);
  // 都度ライブ状態を確認（チャット中の moocs_login 成功後など接続変化に追従）
  if (ctx.mcpClient.getStatus() !== "connected") {
    return {
      content:
        "Error: MCP is not connected. Ask the user to configure MOOCs credentials and connect in Settings.",
      citations: [],
    };
  }

  const healthy = await withAbort(ctx.mcpClient.ping(ctx.signal), ctx.signal);
  if (!healthy) {
    return {
      content: "Error: MCP connection lost. Ask the user to reconnect in Settings.",
      citations: [],
    };
  }

  const result = await withAbort(fn(), ctx.signal);
  return {
    content: truncate(result.content),
    citations: result.citations,
    materials: result.materials,
  };
}

function validateAgentToolArguments(
  toolName: string,
  args: Record<string, unknown>
): string | null {
  const keys = Object.keys(args);
  if (NO_ARGUMENT_AGENT_TOOLS.has(toolName)) {
    return keys.length === 0 ? null : `${toolName} does not accept arguments`;
  }

  if (toolName === "moocs_navigate") {
    if (keys.length !== 1 || keys[0] !== "url") return "moocs_navigate accepts only url";
    if (typeof args.url !== "string" || !args.url.trim()) return "url must be a non-empty string";
    if (args.url.length > MAX_URL_CHARS) return "url is too long";
    return null;
  }

  if (toolName === "moocs_read_slide") {
    if (keys.some((key) => key !== "url")) return "moocs_read_slide accepts only url";
    if ("url" in args && (typeof args.url !== "string" || !args.url.trim())) {
      return "url must be a non-empty string when provided";
    }
    if (typeof args.url === "string" && args.url.length > MAX_URL_CHARS) {
      return "url is too long";
    }
    return null;
  }

  if (toolName === "web_search") {
    if (keys.length !== 1 || keys[0] !== "query") return "web_search accepts only query";
    if (typeof args.query !== "string" || !args.query.trim()) {
      return "query must be a non-empty string";
    }
    if (args.query.length > MAX_WEB_QUERY_CHARS) {
      return `query must be at most ${MAX_WEB_QUERY_CHARS} characters`;
    }
  }
  return null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("リクエストがキャンセルされました");
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("リクエストがキャンセルされました"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
