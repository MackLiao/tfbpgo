import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, setArtifactVersion } from "@/api/client";

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
