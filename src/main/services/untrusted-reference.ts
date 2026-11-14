/**
 * 信頼できない参照データ（ツール結果、過去の資料、索引のヒント）を囲む境界。
 * 中身に境界のマーカーが紛れていても、囲みを抜け出せないように取り除く。
 */

export const UNTRUSTED_REFERENCE_START = "<BEGIN_UNTRUSTED_REFERENCE_DATA>";
export const UNTRUSTED_REFERENCE_END = "<END_UNTRUSTED_REFERENCE_DATA>";

export function wrapUntrustedReference(content: string, label: string): string {
  return [
    `${UNTRUSTED_REFERENCE_START} type=${label}`,
    sanitizeUntrustedData(content),
    UNTRUSTED_REFERENCE_END,
  ].join("\n");
}

export function sanitizeUntrustedData(value: string): string {
  return value
    .split(UNTRUSTED_REFERENCE_START)
    .join("[BOUNDARY_MARKER_REMOVED]")
    .split(UNTRUSTED_REFERENCE_END)
    .join("[BOUNDARY_MARKER_REMOVED]");
}
