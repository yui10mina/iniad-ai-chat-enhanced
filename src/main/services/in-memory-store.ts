/**
 * インメモリ状態管理クラス（MVP用）
 *
 * 将来のSettingsStore実装までの一時的な実装。
 * チャット履歴とアプリステータスをメモリ上で管理する。
 */

import type {
  AppStatus,
  ChatTurn,
  Citation,
  MaterialContextSummary,
  McpConnectionState,
  McpStatus,
} from "../../shared/types";
import { CHAT_MODEL } from "../../shared/types/settings";

export interface MaterialContextInput {
  title: string;
  url: string;
  content: string;
  location?: string;
  sourceType?: Citation["sourceType"];
  snippet?: string;
  referencedAt?: string;
}

export interface MaterialContextEntry extends MaterialContextInput {
  id: string;
  firstReferencedAt: string;
  lastReferencedAt: string;
}

export interface SelectedMaterialContext extends MaterialContextEntry {
  relevanceScore: number;
}

export const MATERIAL_CONTEXT_LIMITS = {
  maxEntries: 30,
  maxStoredCharsPerEntry: 4_000,
  maxSelectedEntries: 3,
  maxSelectedChars: 4_500,
  maxSelectedCharsPerEntry: 1_800,
} as const;

export const MATERIAL_METADATA_LIMITS = {
  maxTitleChars: 300,
  maxLocationChars: 200,
  maxUrlChars: 2_048,
} as const;

const MATERIAL_REFERENCE_PATTERN =
  /(?:以前|前回|前に|先ほど|さっき|これまで|過去).{0,16}(?:資料|スライド|講義|出典|内容|説明)/;
const QUERY_NOISE_PATTERN =
  /(?:以前|前回|前に|先ほど|さっき|これまで|過去|資料|スライド|講義|出典|内容|説明|踏まえて|基づいて|参照して|もう一度|教えて|ください|です|ます)/g;
const QUERY_SPLIT_PATTERN =
  /[\s\u3000、。！？・,.;:：；()（）「」『』【】[\]のはがをにでともへやからまで]+/;

export class InMemoryStore {
  private static readonly MAX_HISTORY = 200;
  private chatHistory: ChatTurn[] = [];
  /** 資料本文は Main 内だけで保持し、Renderer には summary のみ返す。 */
  private materialContext: MaterialContextEntry[] = [];
  private mcpStatus: McpStatus = "disconnected";
  private mcpConnection: McpConnectionState = { status: "disconnected" };
  private currentModel: string = CHAT_MODEL;
  private hasApiKey: boolean = false;

  addMessage(message: ChatTurn): void {
    this.chatHistory.push(message);
    if (this.chatHistory.length > InMemoryStore.MAX_HISTORY) {
      this.chatHistory.shift();
    }
  }

  removeMessage(id: string): boolean {
    const index = this.chatHistory.findIndex((message) => message.id === id);
    if (index < 0) return false;
    this.chatHistory.splice(index, 1);
    return true;
  }

  getHistory(): ChatTurn[] {
    return [...this.chatHistory];
  }

  clearHistory(): void {
    this.clearConversationHistory();
  }

  clearConversationHistory(): void {
    this.chatHistory = [];
  }

  addMaterial(input: MaterialContextInput): MaterialContextSummary | null {
    const normalizedUrl = normalizeMaterialUrl(input.url);
    const content = input.content.trim();
    if (!normalizedUrl || !isUsefulMaterialContent(content)) return null;

    const now = normalizeTimestamp(input.referencedAt);
    const boundedContent = truncateText(content, MATERIAL_CONTEXT_LIMITS.maxStoredCharsPerEntry);
    const existingIndex = this.materialContext.findIndex((entry) => entry.url === normalizedUrl);
    const existing = existingIndex >= 0 ? this.materialContext[existingIndex] : undefined;

    const entry: MaterialContextEntry = {
      id: existing?.id ?? createMaterialId(normalizedUrl),
      title: truncateText(
        preferDetailedLabel(existing?.title, input.title) || "参照資料",
        MATERIAL_METADATA_LIMITS.maxTitleChars
      ),
      url: normalizedUrl,
      content:
        !existing || boundedContent.length >= existing.content.length
          ? boundedContent
          : existing.content,
      location: truncateOptional(
        input.location?.trim() || existing?.location,
        MATERIAL_METADATA_LIMITS.maxLocationChars
      ),
      sourceType: input.sourceType ?? existing?.sourceType,
      snippet: truncateOptional(input.snippet?.trim() || existing?.snippet, 500),
      firstReferencedAt: existing?.firstReferencedAt ?? now,
      lastReferencedAt: now,
    };

    if (existingIndex >= 0) this.materialContext.splice(existingIndex, 1);
    this.materialContext.push(entry);
    while (this.materialContext.length > MATERIAL_CONTEXT_LIMITS.maxEntries) {
      this.materialContext.shift();
    }

    return toMaterialSummary(entry);
  }

  addMaterials(inputs: readonly MaterialContextInput[]): MaterialContextSummary[] {
    const added: MaterialContextSummary[] = [];
    for (const input of inputs) {
      const summary = this.addMaterial(input);
      if (summary) added.push(summary);
    }
    return added;
  }

  /**
   * 質問に関連する過去資料だけを選び、本文も関連箇所へ絞って返す。
   * 「以前の資料」等の明示がある場合は最近参照した資料へ小さな加点を行う。
   */
  selectRelevantMaterials(query: string): SelectedMaterialContext[] {
    if (this.materialContext.length === 0) return [];

    const explicitPriorReference = refersToPriorMaterials(query);
    const tokens = tokenizeMaterialQuery(query);
    const scored = this.materialContext
      .map((entry, index) => {
        const lexicalScore = scoreMaterial(entry, tokens);
        const ageFromNewest = this.materialContext.length - 1 - index;
        const recencyBonus = explicitPriorReference
          ? Math.max(0.05, 0.3 - ageFromNewest * 0.03)
          : 0;
        return { entry, index, lexicalScore, score: lexicalScore + recencyBonus };
      })
      .filter(({ lexicalScore }) => lexicalScore > 0 || explicitPriorReference)
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .slice(0, MATERIAL_CONTEXT_LIMITS.maxSelectedEntries);

    const selected: SelectedMaterialContext[] = [];
    let remainingChars = MATERIAL_CONTEXT_LIMITS.maxSelectedChars;
    for (const match of scored) {
      if (remainingChars <= 0) break;
      const excerptLimit = Math.min(
        MATERIAL_CONTEXT_LIMITS.maxSelectedCharsPerEntry,
        remainingChars
      );
      const excerpt = extractRelevantExcerpt(match.entry.content, tokens, excerptLimit);
      if (!excerpt) continue;
      selected.push({
        ...match.entry,
        content: excerpt,
        relevanceScore: Number(match.score.toFixed(3)),
      });
      remainingChars -= excerpt.length;
    }

    return selected;
  }

  /** 回答が確定した後にだけ、実際に再利用した資料を最新参照として記録する。 */
  markMaterialsReferenced(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const referencedAt = new Date().toISOString();
    for (const id of [...new Set(ids)].reverse()) {
      const index = this.materialContext.findIndex((entry) => entry.id === id);
      if (index < 0) continue;
      const [entry] = this.materialContext.splice(index, 1);
      entry.lastReferencedAt = referencedAt;
      this.materialContext.push(entry);
    }
  }

  getMaterialContextSummaries(): MaterialContextSummary[] {
    return [...this.materialContext].reverse().map(toMaterialSummary);
  }

  getMaterialContextCount(): number {
    return this.materialContext.length;
  }

  clearMaterialContext(): void {
    this.materialContext = [];
  }

  clearAllContext(): void {
    this.clearConversationHistory();
    this.clearMaterialContext();
  }

  getMcpStatus(): McpStatus {
    return this.mcpStatus;
  }

  setMcpStatus(status: McpStatus): void {
    this.mcpStatus = status;
    this.mcpConnection =
      status === "connected"
        ? { status, lastConnectedAt: this.mcpConnection.lastConnectedAt }
        : { ...this.mcpConnection, status };
  }

  getMcpConnectionState(): McpConnectionState {
    return {
      ...this.mcpConnection,
      error: this.mcpConnection.error ? { ...this.mcpConnection.error } : undefined,
    };
  }

  setMcpConnectionState(state: McpConnectionState): void {
    this.mcpStatus = state.status;
    this.mcpConnection = {
      ...state,
      error: state.error ? { ...state.error } : undefined,
    };
  }

  getAppStatus(): AppStatus {
    return {
      mcpStatus: this.mcpStatus,
      mcpConnection: this.getMcpConnectionState(),
      model: this.currentModel,
      hasApiKey: this.hasApiKey,
    };
  }

  setModel(model: string): void {
    this.currentModel = model;
  }

  setHasApiKey(hasKey: boolean): void {
    this.hasApiKey = hasKey;
  }
}

export function refersToPriorMaterials(query: string): boolean {
  return MATERIAL_REFERENCE_PATTERN.test(query.normalize("NFKC"));
}

function tokenizeMaterialQuery(query: string): string[] {
  const normalized = query.normalize("NFKC").toLowerCase().replace(QUERY_NOISE_PATTERN, " ");
  return [...new Set(normalized.split(QUERY_SPLIT_PATTERN).map((token) => token.trim()))].filter(
    (token) => token.length >= 2
  );
}

function scoreMaterial(entry: MaterialContextEntry, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const titleAndLocation = `${entry.title} ${entry.location ?? ""}`.normalize("NFKC").toLowerCase();
  const searchable = `${titleAndLocation} ${entry.snippet ?? ""} ${entry.content}`
    .normalize("NFKC")
    .toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (searchable.includes(token)) score += 1;
    if (titleAndLocation.includes(token)) score += 0.75;
  }
  return score / tokens.length;
}

function extractRelevantExcerpt(content: string, tokens: string[], maxChars: number): string {
  if (content.length <= maxChars) return content;

  const segments = content
    .split(/(?<=[。！？])|\r?\n+/)
    .map((text, index) => ({ text: text.trim(), index }))
    .filter(({ text }) => text.length > 0);
  const ranked = segments
    .map((segment) => ({
      ...segment,
      score: tokens.reduce(
        (count, token) =>
          count + (segment.text.normalize("NFKC").toLowerCase().includes(token) ? 1 : 0),
        0
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (ranked.length === 0) {
    return cropAroundFirstToken(content, tokens, maxChars);
  }

  const chosen: Array<{ text: string; index: number }> = [];
  let used = 0;
  for (const segment of ranked) {
    const separatorChars = chosen.length > 0 ? 1 : 0;
    if (used + separatorChars >= maxChars) break;
    const available = maxChars - used - separatorChars;
    chosen.push({ text: truncateText(segment.text, available), index: segment.index });
    used += Math.min(segment.text.length, available) + separatorChars;
    if (used >= maxChars) break;
  }
  return chosen
    .sort((a, b) => a.index - b.index)
    .map(({ text }) => text)
    .join("\n");
}

function cropAroundFirstToken(content: string, tokens: string[], maxChars: number): string {
  const normalized = content.normalize("NFKC").toLowerCase();
  const positions = tokens.map((token) => normalized.indexOf(token)).filter((index) => index >= 0);
  const firstPosition = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, firstPosition - Math.floor(maxChars / 3));
  return content.slice(start, start + maxChars);
}

export function normalizeMaterialUrl(url: string): string | null {
  if (url.length === 0 || url.length > MATERIAL_METADATA_LIMITS.maxUrlChars) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    parsed.hash = "";
    const normalized = parsed.toString();
    return parsed.pathname === "/" ? normalized : normalized.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function normalizeTimestamp(timestamp?: string): string {
  if (timestamp && Number.isFinite(Date.parse(timestamp))) return new Date(timestamp).toISOString();
  return new Date().toISOString();
}

function isUsefulMaterialContent(content: string): boolean {
  if (!content) return false;
  return (
    !/^(?:error:|tool error:|navigated to|no web results)/i.test(content) &&
    !/^status:\s*非公開/im.test(content)
  );
}

function preferDetailedLabel(current: string | undefined, incoming: string | undefined): string {
  const oldLabel = current?.trim() ?? "";
  const newLabel = incoming?.trim() ?? "";
  if (!newLabel) return oldLabel;
  if (!oldLabel) return newLabel;
  const generic = /^(?:MOOCs|MOOCs スライド|MOOCs ページ|参照資料)$/i;
  if (generic.test(oldLabel) && !generic.test(newLabel)) return newLabel;
  return newLabel.length >= oldLabel.length ? newLabel : oldLabel;
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function truncateOptional(text: string | undefined, maxChars: number): string | undefined {
  return text ? truncateText(text, maxChars) : undefined;
}

function createMaterialId(url: string): string {
  let hash = 2166136261;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `material_${(hash >>> 0).toString(36)}`;
}

function toMaterialSummary(entry: MaterialContextEntry): MaterialContextSummary {
  return {
    id: entry.id,
    title: entry.title,
    url: entry.url,
    location: entry.location,
    lastReferencedAt: entry.lastReferencedAt,
  };
}
