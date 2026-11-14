/** 回答に付ける引用を、URL が同じものは 1 件にまとめながら集める。 */
import type { Citation } from "../../shared/types/chat";
import { normalizeMaterialUrl } from "./in-memory-store";

export function mergeCitation(citations: Citation[], incoming: Citation): void {
  const normalizedUrl = normalizeMaterialUrl(incoming.url) ?? incoming.url;
  const existingIndex = citations.findIndex(
    (citation) => (normalizeMaterialUrl(citation.url) ?? citation.url) === normalizedUrl
  );
  if (existingIndex < 0) {
    citations.push(incoming);
    return;
  }

  const current = citations[existingIndex];
  const currentTitleIsGeneric = /^(?:MOOCs|MOOCs スライド|MOOCs ページ)$/i.test(current.title);
  citations[existingIndex] = {
    ...current,
    ...incoming,
    title:
      currentTitleIsGeneric || incoming.title.length > current.title.length
        ? incoming.title
        : current.title,
    snippet: incoming.snippet ?? current.snippet,
    location: incoming.location ?? current.location,
    sourceType: incoming.sourceType ?? current.sourceType,
  };
}
