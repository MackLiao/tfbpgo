import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Binding } from "@/routes/Binding";
import { Perturbation } from "@/routes/Perturbation";
import { setArtifactVersion } from "@/api/client";

describe("Binding route URL keys", () => {
  beforeEach(() => {
    setArtifactVersion("test");
  });

  it("reads dataset list from the ?binding= URL key (not ?datasets=)", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        calls.push(url);
        return Promise.resolve(
          new Response(JSON.stringify({ datasets: [] }), { status: 200 }),
        );
      }),
    );

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/binding?regulator=YAL001C&binding=callingcards"]}>
          <Binding />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(calls.some((u) => u.includes("/binding"))).toBe(true);
    });
    const bindingCall = calls.find((u) => u.includes("/binding") && u.includes("regulator="));
    expect(bindingCall).toBeDefined();
    expect(bindingCall!).toContain("regulator=YAL001C");
    expect(bindingCall!).toContain("datasets=callingcards");
  });
});

describe("Perturbation route URL keys", () => {
  beforeEach(() => {
    setArtifactVersion("test");
  });

  it("reads dataset list from the ?perturbation= URL key (not ?datasets=)", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        calls.push(url);
        return Promise.resolve(
          new Response(JSON.stringify({ datasets: [] }), { status: 200 }),
        );
      }),
    );

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter
          initialEntries={["/perturbation?regulator=YAL001C&perturbation=hackett"]}
        >
          <Perturbation />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(calls.some((u) => u.includes("/perturbation"))).toBe(true);
    });
    const perturbCall = calls.find(
      (u) => u.includes("/perturbation") && u.includes("regulator="),
    );
    expect(perturbCall).toBeDefined();
    expect(perturbCall!).toContain("regulator=YAL001C");
    expect(perturbCall!).toContain("datasets=hackett");
  });
});
