export type MoocsPageKind =
  | "slide"
  | "exercise"
  | "review"
  | "attendance"
  | "lecture"
  | "course"
  | "other";

/** MOOCs URL のページ種別（Google スライドがあるのは slide のみ） */
export function getMoocsPageKind(url: string): MoocsPageKind {
  const path = url.replace(/\/$/, "");
  if (/\/atnd$/.test(path)) return "attendance";
  if (/\/exercise$/.test(path)) return "exercise";
  if (/\/review$/.test(path)) return "review";
  // 講義回は数字 2 桁とは限らない（例: vod01）。資料の番号は数字 2 桁。
  if (/\/courses\/\d{4}\/[A-Z0-9]+\/[A-Za-z0-9_-]+\/\d{2}$/.test(path)) return "slide";
  if (/\/courses\/\d{4}\/[A-Z0-9]+\/[A-Za-z0-9_-]+$/.test(path)) return "lecture";
  if (/\/courses\/\d{4}\/[A-Z0-9]+$/.test(path)) return "course";
  return "other";
}

export function isGoogleSlidePage(url: string): boolean {
  return getMoocsPageKind(url) === "slide";
}

export function pageCitationTitle(url: string): string {
  const kind = getMoocsPageKind(url);
  switch (kind) {
    case "review":
      return "課題解説";
    case "exercise":
      return "演習課題";
    case "attendance":
      return "出席確認";
    case "slide":
      return "MOOCs スライド";
    default:
      return "MOOCs";
  }
}

/** MOOCs URL から引用表示用の講義回・資料位置を推定する。 */
export function inferMoocsLocation(url: string): string | undefined {
  try {
    const parts = new URL(url).pathname.replace(/\/$/, "").split("/");
    const coursesIndex = parts.indexOf("courses");
    const lecture = coursesIndex >= 0 ? parts[coursesIndex + 3] : undefined;
    const page = coursesIndex >= 0 ? parts[coursesIndex + 4] : undefined;
    if (!lecture) return undefined;

    const formatIndexNumber = (value: string): string => {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? String(parsed) : value;
    };
    // 講義回が数字のときだけ「第N回」にする。vod01 のような名前はそのまま出す。
    const lectureLabel = /^\d+$/.test(lecture) ? `第${formatIndexNumber(lecture)}回` : lecture;
    if (!page) return lectureLabel;
    if (/^\d+$/.test(page)) return `${lectureLabel} / 資料${formatIndexNumber(page)}`;
    if (page === "review") return `${lectureLabel} / 課題解説`;
    if (page === "exercise") return `${lectureLabel} / 演習課題`;
    return lectureLabel;
  } catch {
    return undefined;
  }
}
