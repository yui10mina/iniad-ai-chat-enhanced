import { describe, it, expect, vi } from "vitest";
import { MoocsPageReader } from "../../src/main/services/moocs-page-reader";
import type { McpClient } from "../../src/main/services/mcp-client";
import type { SlidesIndexService } from "../../src/main/services/slides-index";

const SLIDE_URL = "https://moocs.iniad.org/courses/2026/COS201/01/01";
const REVIEW_URL = "https://moocs.iniad.org/courses/2026/COS201/01/review";

function createMcpMock(overrides: Partial<McpClient> = {}): McpClient {
  return {
    navigateTo: vi.fn().mockResolvedValue(undefined),
    expandSlideTab: vi.fn().mockResolvedValue(undefined),
    extractGoogleSlideText: vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            moocsUrl: SLIDE_URL,
            text: "C言語は組込みシステムで標準的な言語である。",
            slideCount: 1,
          }),
        },
      ],
    }),
    getPageSnapshot: vi.fn().mockResolvedValue("現在この問題は非公開です"),
    ...overrides,
  } as unknown as McpClient;
}

describe("MoocsPageReader", () => {
  it("reads HTML review page without Google slide extraction", async () => {
    const mcpClient = createMcpMock();
    const reader = new MoocsPageReader(mcpClient);

    const result = await reader.readPage(REVIEW_URL);

    expect(mcpClient.navigateTo).toHaveBeenCalledWith(REVIEW_URL, undefined);
    expect(mcpClient.extractGoogleSlideText).not.toHaveBeenCalled();
    expect(result.content).toContain("Page kind: review");
    expect(result.content).toContain("非公開");
    expect(result.citations.some((c) => c.url === REVIEW_URL)).toBe(true);
  });

  it("uses slides-index when loaded before MCP extraction", async () => {
    const mcpClient = createMcpMock();
    const slidesIndex = {
      isLoaded: vi.fn().mockReturnValue(true),
      getEntryByMoocsUrl: vi.fn().mockReturnValue({
        courseCode: "COS201",
        courseName: "プログラミング言語",
        lectureNum: "01",
        slideNum: "01",
        slideTitle: "C言語の光と影",
        moocsUrl: SLIDE_URL,
        text: "indexed slide text",
        keywords: [],
      }),
    } as unknown as SlidesIndexService;

    const reader = new MoocsPageReader(mcpClient, slidesIndex);
    const result = await reader.readPage(SLIDE_URL);

    expect(slidesIndex.getEntryByMoocsUrl).toHaveBeenCalledWith(SLIDE_URL);
    expect(mcpClient.extractGoogleSlideText).not.toHaveBeenCalled();
    expect(result.content).toContain("slides-index");
    expect(result.content).toContain("indexed slide text");
    expect(result.citations[0]).toMatchObject({
      title: "プログラミング言語: C言語の光と影",
      location: "第1回 / 資料1",
      sourceType: "moocs",
    });
    expect(result.materials).toEqual([
      expect.objectContaining({
        url: SLIDE_URL,
        content: expect.stringContaining("indexed slide text"),
      }),
    ]);
  });

  it("extracts Google slide text when index has no entry", async () => {
    const mcpClient = createMcpMock();
    const slidesIndex = {
      isLoaded: vi.fn().mockReturnValue(true),
      getEntryByMoocsUrl: vi.fn().mockReturnValue(null),
    } as unknown as SlidesIndexService;

    const reader = new MoocsPageReader(mcpClient, slidesIndex);
    const result = await reader.readPage(SLIDE_URL);

    expect(mcpClient.expandSlideTab).toHaveBeenCalled();
    expect(mcpClient.extractGoogleSlideText).toHaveBeenCalled();
    expect(result.content).toContain("C言語");
  });

  it("records extracted content only against the resolved primary citation", async () => {
    const resolvedUrl = "https://moocs.iniad.org/courses/2026/COS201/01/02";
    const mcpClient = createMcpMock({
      extractGoogleSlideText: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              moocsUrl: resolvedUrl,
              text: "Resolved lecture material explains primary citation ownership and keeps extracted slide content associated with one canonical source.",
              slideCount: 1,
            }),
          },
        ],
      }),
    });
    const reader = new MoocsPageReader(mcpClient);
    const citations = [{ title: "Requested slide", url: SLIDE_URL, sourceType: "moocs" as const }];

    const result = await reader.tryExtractSlideText(citations);

    expect(result?.citations.map((citation) => citation.url)).toEqual([SLIDE_URL, resolvedUrl]);
    expect(result?.materials).toEqual([
      expect.objectContaining({ url: resolvedUrl, content: expect.stringContaining("Resolved") }),
    ]);
  });

  describe("outcome", () => {
    const READABLE =
      "C言語は組込みシステムで標準的な言語であり、ポインタによってメモリを直接扱える。";
    const extractReturning = (payload: unknown) =>
      vi.fn().mockResolvedValue({
        content: [
          { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) },
        ],
      });

    it("marks readable slide text as ok and records it", async () => {
      const reader = new MoocsPageReader(
        createMcpMock({ extractGoogleSlideText: extractReturning({ text: READABLE }) })
      );

      const result = await reader.readPage(SLIDE_URL);

      expect(result.outcome).toEqual({ ok: true, code: "ok" });
      expect(result.materials).toHaveLength(1);
    });

    // 判定は content の文字列ではなく、抽出結果の error で決まる。
    it("marks slide text that comes with an error as slide_extract_failed and does not record it", async () => {
      const cache = new Map<string, string>();
      const mcpClient = createMcpMock({
        extractGoogleSlideText: extractReturning({ text: READABLE, error: "partial_extract" }),
      });
      const reader = new MoocsPageReader(mcpClient, undefined, cache);

      const result = await reader.readPage(SLIDE_URL);

      expect(result.outcome).toEqual({ ok: false, code: "slide_extract_failed" });
      expect(result.materials).toBeUndefined();
      expect(cache.has(SLIDE_URL)).toBe(false);
    });

    it("records slide text whose body merely starts with the word Error", async () => {
      const text = `Error: という表示が出たときの対処を学ぶ。${READABLE}`;
      const reader = new MoocsPageReader(
        createMcpMock({ extractGoogleSlideText: extractReturning({ text }) })
      );

      const result = await reader.tryExtractSlideText([
        { title: "Requested slide", url: SLIDE_URL, sourceType: "moocs" },
      ]);

      expect(result?.content.startsWith("Error:")).toBe(true);
      expect(result?.outcome).toEqual({ ok: true, code: "ok" });
      expect(result?.materials).toHaveLength(1);
    });

    it("applies the same rule to tryExtractSlideText", async () => {
      const reader = new MoocsPageReader(
        createMcpMock({
          extractGoogleSlideText: extractReturning({
            moocsUrl: SLIDE_URL,
            text: READABLE,
            error: "partial_extract",
          }),
        })
      );

      const result = await reader.tryExtractSlideText([]);

      expect(result?.outcome).toEqual({ ok: false, code: "slide_extract_failed" });
      expect(result?.materials).toBeUndefined();
    });

    it.each<{ name: string; payload: unknown; code: string }>([
      {
        name: "an extraction error without text",
        payload: { error: "iframe_timeout", hint: "retry" },
        code: "slide_extract_failed",
      },
      {
        name: "text too short to be a slide",
        payload: { text: "短い" },
        code: "content_unavailable",
      },
      { name: "a result that is not JSON", payload: "not json", code: "content_unavailable" },
      {
        name: "a Google login wall",
        payload: { error: "google_login_required" },
        code: "google_login_required",
      },
    ])("marks $name as $code", async ({ payload, code }) => {
      const reader = new MoocsPageReader(
        createMcpMock({ extractGoogleSlideText: extractReturning(payload) })
      );

      const result = await reader.readPage(SLIDE_URL);

      expect(result.outcome).toEqual({ ok: false, code });
      expect(result.materials).toBeUndefined();
    });

    describe("slides whose text cannot be extracted", () => {
      const VOD_URL = "https://moocs.iniad.org/courses/2099/TEST101/01/03";
      const PAGE = "合成のページ。これは架空の本文で、実在の教材ではない。見出しとリンクがある。";
      const NOTE = "Slides: このページにはスライドがありますが、文字を取り出せませんでした。";

      it.each(["empty_slide_text", "iframe_src_missing", "presentation_id_not_found"])(
        "returns the page's HTML with a note for %s",
        async (error) => {
          const mcpClient = createMcpMock({
            extractGoogleSlideText: extractReturning({ error, moocsUrl: VOD_URL }),
            getPageSnapshot: vi.fn().mockResolvedValue(PAGE),
          });
          const reader = new MoocsPageReader(mcpClient);

          const result = await reader.readPage(VOD_URL);

          expect(result.outcome).toEqual({ ok: true, code: "ok" });
          expect(result.content).toContain(NOTE);
          expect(result.content).toContain("読み直しても結果は変わりません");
          expect(result.content).toContain(PAGE);
          expect(result.content.startsWith(`MOOCs URL: ${VOD_URL}\n`)).toBe(true);
          expect(result.materials).toEqual([
            expect.objectContaining({ url: VOD_URL, content: expect.stringContaining(PAGE) }),
          ]);
        }
      );

      it("does not try the extraction again for the same page in the same chat", async () => {
        const cache = new Map<string, string>();
        const mcpClient = createMcpMock({
          extractGoogleSlideText: extractReturning({
            error: "empty_slide_text",
            moocsUrl: VOD_URL,
          }),
          getPageSnapshot: vi.fn().mockResolvedValue(PAGE),
        });
        const reader = new MoocsPageReader(mcpClient, undefined, cache);

        await reader.readPage(VOD_URL);
        const again = await reader.readPage(VOD_URL);

        expect(mcpClient.extractGoogleSlideText).toHaveBeenCalledTimes(1);
        expect(again.content).toContain(NOTE);
      });

      it("uses the URL from the extraction result when it was called without one", async () => {
        const cache = new Map<string, string>();
        const mcpClient = createMcpMock({
          extractGoogleSlideText: extractReturning({
            error: "empty_slide_text",
            moocsUrl: VOD_URL,
          }),
          getPageSnapshot: vi.fn().mockResolvedValue(PAGE),
        });
        const reader = new MoocsPageReader(mcpClient, undefined, cache);

        const result = await reader.readPage();

        expect(mcpClient.navigateTo).not.toHaveBeenCalled();
        expect(result.content.startsWith(`MOOCs URL: ${VOD_URL}\n`)).toBe(true);
        expect(result.content).toContain(NOTE);
        expect(result.citations.map((citation) => citation.url)).toEqual([VOD_URL]);
        expect([...cache.keys()]).toEqual([VOD_URL]);
      });

      it("does not add the note when the page simply has no slides", async () => {
        const mcpClient = createMcpMock({
          extractGoogleSlideText: extractReturning({
            error: "no_google_slides_iframe",
            moocsUrl: VOD_URL,
          }),
          getPageSnapshot: vi.fn().mockResolvedValue(PAGE),
        });
        const reader = new MoocsPageReader(mcpClient);

        const result = await reader.readPage(VOD_URL);

        expect(result.outcome).toEqual({ ok: true, code: "ok" });
        expect(result.content).toContain(PAGE);
        expect(result.content).not.toContain("Slides:");
      });

      it("does not cache a page whose URL is unknown", async () => {
        const cache = new Map<string, string>();
        const mcpClient = createMcpMock({
          extractGoogleSlideText: extractReturning({ error: "empty_slide_text" }),
          getPageSnapshot: vi.fn().mockResolvedValue(PAGE),
        });
        const reader = new MoocsPageReader(mcpClient, undefined, cache);

        const result = await reader.readPage();

        expect(result.content).toContain(NOTE);
        expect(cache.size).toBe(0);
      });
    });

    it("marks a private page as read but not published, also when it comes from the cache", async () => {
      const cache = new Map<string, string>();
      const reader = new MoocsPageReader(createMcpMock(), undefined, cache);

      const first = await reader.readPage(REVIEW_URL);
      const second = await reader.readPage(REVIEW_URL);

      expect(first.outcome).toEqual({ ok: true, code: "not_published" });
      expect(first.materials).toBeUndefined();
      expect(second.outcome).toEqual({ ok: true, code: "not_published" });
      expect(second.materials).toBeUndefined();
    });

    it("marks an empty HTML page as content_unavailable", async () => {
      const reader = new MoocsPageReader(
        createMcpMock({ getPageSnapshot: vi.fn().mockResolvedValue("") })
      );

      const result = await reader.readPage(REVIEW_URL);

      expect(result.outcome).toEqual({ ok: false, code: "content_unavailable" });
    });
  });

  it("returns cached content on repeated read", async () => {
    const mcpClient = createMcpMock();
    const cache = new Map<string, string>();
    cache.set(SLIDE_URL, "cached content");

    const reader = new MoocsPageReader(mcpClient, undefined, cache);
    const result = await reader.readPage(SLIDE_URL);

    expect(mcpClient.navigateTo).not.toHaveBeenCalled();
    expect(result.content).toBe("cached content");
  });
});
