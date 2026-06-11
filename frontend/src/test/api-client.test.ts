import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, setArtifactVersion, ApiError, apiErrorMessage } from "@/api/client";

beforeEach(() => {
  setArtifactVersion("test-v1");
});

describe("api.regulators", () => {
  it("builds /regulators URL with search and limit", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ regulators: [] }), { status: 200 }));
    await api.regulators({ search: "yox", limit: 10 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v/test-v1/regulators?search=yox&limit=10",
      expect.anything(),
    );
  });
});

describe("apiErrorMessage", () => {
  it("surfaces the backend's readable {error} body for an ApiError", () => {
    const err = new ApiError(400, {
      error:
        "too many comparisons: 24 binding×perturbation pairs requested (max 6) — select fewer binding or perturbation datasets",
    });
    expect(apiErrorMessage(err)).toBe(
      "too many comparisons: 24 binding×perturbation pairs requested (max 6) — select fewer binding or perturbation datasets",
    );
  });

  it("falls back to HTTP <status> when the body has no error string", () => {
    expect(apiErrorMessage(new ApiError(503, null))).toBe("HTTP 503");
    expect(apiErrorMessage(new ApiError(502, "gateway"))).toBe("HTTP 502");
    expect(apiErrorMessage(new ApiError(400, { error: "" }))).toBe("HTTP 400");
  });

  it("passes through a plain Error message and stringifies anything else", () => {
    expect(apiErrorMessage(new Error("boom"))).toBe("boom");
    expect(apiErrorMessage("weird")).toBe("weird");
  });
});

describe("stale version handling", () => {
  it("reloads on 410", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { reload }, writable: true });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("stale", { status: 410 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            artifactVersion: "v2",
            schemaVersion: 2,
            builtAt: "2026-01-01T00:00:00Z",
            duckdbVersion: "1.x",
          }),
          { status: 200 },
        ),
      );
    void api.datasets();
    await new Promise((r) => setTimeout(r, 10));
    expect(reload).toHaveBeenCalled();
  });
});
