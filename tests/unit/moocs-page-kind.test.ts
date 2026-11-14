import { describe, it, expect } from "vitest";
import {
  getMoocsPageKind,
  inferMoocsLocation,
  isGoogleSlidePage,
  pageCitationTitle,
} from "../../src/main/services/moocs-page-kind";

describe("moocs-page-kind", () => {
  describe("getMoocsPageKind", () => {
    it("classifies page types from URL", () => {
      expect(getMoocsPageKind("https://moocs.iniad.org/courses/2026/COS201/01/01")).toBe("slide");
      expect(getMoocsPageKind("https://moocs.iniad.org/courses/2026/COS201/01/review")).toBe(
        "review"
      );
      expect(getMoocsPageKind("https://moocs.iniad.org/courses/2026/COS201/01/exercise")).toBe(
        "exercise"
      );
      expect(getMoocsPageKind("https://moocs.iniad.org/courses/2026/COS201/01/atnd")).toBe(
        "attendance"
      );
      expect(isGoogleSlidePage("https://moocs.iniad.org/courses/2026/COS201/01/review")).toBe(
        false
      );
    });
  });

  describe("pageCitationTitle", () => {
    it("returns localized title for page kind", () => {
      expect(pageCitationTitle("https://moocs.iniad.org/courses/2026/COS201/01/review")).toBe(
        "課題解説"
      );
      expect(pageCitationTitle("https://moocs.iniad.org/courses/2026/COS201/01/01")).toBe(
        "MOOCs スライド"
      );
    });
  });

  describe("inferMoocsLocation", () => {
    it("uses the same localized locations for slides and HTML learning pages", () => {
      expect(inferMoocsLocation("https://moocs.iniad.org/courses/2026/COS201/01/02")).toBe(
        "第1回 / 資料2"
      );
      expect(inferMoocsLocation("https://moocs.iniad.org/courses/2026/COS201/01/review")).toBe(
        "第1回 / 課題解説"
      );
      expect(inferMoocsLocation("https://moocs.iniad.org/courses/2026/COS201/01/exercise")).toBe(
        "第1回 / 演習課題"
      );
    });

    // 講義回が数字でないコースがある（例: vod01）。「第vod01回」とは表示しない。
    it("shows a lecture id that is not a number as it is", () => {
      expect(inferMoocsLocation("https://moocs.iniad.org/courses/2099/TEST101/vod01/02")).toBe(
        "vod01 / 資料2"
      );
      expect(inferMoocsLocation("https://moocs.iniad.org/courses/2099/TEST101/vod01")).toBe(
        "vod01"
      );
      expect(inferMoocsLocation("https://moocs.iniad.org/courses/2099/TEST101/vod01/review")).toBe(
        "vod01 / 課題解説"
      );
    });
  });
});
