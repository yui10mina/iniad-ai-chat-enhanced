import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, apiRequestJson, buildApiUrl } from "../../src/main/services/api-client";

function response(options: {
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}) {
  return {
    ok: options.ok,
    status: options.status,
    headers: new Headers(options.headers),
    json: vi.fn().mockResolvedValue(options.json),
    text: vi.fn().mockResolvedValue(options.text ?? ""),
  } as unknown as Response;
}

describe("api-client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes the base URL and endpoint path", () => {
    expect(buildApiUrl("https://api.openai.iniad.org/api/v1/", "/models")).toBe(
      "https://api.openai.iniad.org/api/v1/models"
    );
  });

  it("rejects non-official or insecure API destinations at the request boundary", () => {
    expect(() => buildApiUrl("https://api.example.com/v1", "models")).toThrow("公式 INIAD API");
    expect(() => buildApiUrl("http://api.openai.iniad.org/api/v1", "models")).toThrow(
      "公式 INIAD API"
    );
    expect(() =>
      buildApiUrl("https://user:password@api.openai.iniad.org/api/v1", "models")
    ).toThrow("公式 INIAD API");
    expect(() => buildApiUrl("https://api.openai.iniad.org:8443/api/v1", "models")).toThrow(
      "公式 INIAD API"
    );
  });

  it("does not retry authentication errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response({ ok: false, status: 401, text: "invalid API key sk-secret-value" })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiRequestJson({
        apiKey: "sk-secret-value",
        baseURL: "https://api.openai.iniad.org/api/v1",
        path: "models",
      })
    ).rejects.toMatchObject({ kind: "http", status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    try {
      await apiRequestJson({
        apiKey: "sk-secret-value",
        baseURL: "https://api.openai.iniad.org/api/v1",
        path: "models",
        maxAttempts: 1,
      });
    } catch (error) {
      expect(String(error)).not.toContain("sk-secret-value");
    }
  });

  it("retries 429 responses and honors Retry-After", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: false, status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(response({ ok: true, status: 200, json: { data: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiRequestJson<{ data: unknown[] }>({
        apiKey: "test-key",
        baseURL: "https://api.openai.iniad.org/api/v1",
        path: "models",
      })
    ).resolves.toEqual({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry POST requests unless explicitly enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ ok: false, status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiRequestJson({
        apiKey: "test-key",
        baseURL: "https://api.openai.iniad.org/api/v1",
        path: "chat/completions",
        method: "POST",
        body: { messages: [] },
      })
    ).rejects.toMatchObject({ kind: "http", status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("distinguishes user cancellation from timeout", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = apiRequestJson({
      apiKey: "test-key",
      baseURL: "https://api.openai.iniad.org/api/v1",
      path: "models",
      signal: controller.signal,
      maxAttempts: 1,
    });
    controller.abort();

    await expect(request).rejects.toEqual(
      expect.objectContaining<Partial<ApiRequestError>>({ kind: "cancelled" })
    );
  });

  it("reports a timeout independently from user cancellation", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiRequestJson({
        apiKey: "test-key",
        baseURL: "https://api.openai.iniad.org/api/v1",
        path: "models",
        timeoutMs: 0,
        maxAttempts: 1,
      })
    ).rejects.toEqual(expect.objectContaining<Partial<ApiRequestError>>({ kind: "timeout" }));
  });
});
