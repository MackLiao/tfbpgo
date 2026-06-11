import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import type { ReactNode } from "react";

// Empirically pins the behavior the topn pool-starvation fix relies on: that
// forwarding React Query's AbortSignal to fetch actually causes the in-flight
// request to be aborted (a) when the observer unmounts (navigate away from
// Comparison) and (b) when the query key changes (dataset/param edit supersedes
// the previous fetch). If a future @tanstack/react-query upgrade changes this,
// these tests fail loudly rather than silently re-introducing the freeze.

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe("React Query AbortSignal cancellation", () => {
  it("aborts the in-flight signal when the last observer unmounts", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let captured: AbortSignal | undefined;
    const { unmount } = renderHook(
      () =>
        useQuery({
          queryKey: ["unmount-case"],
          queryFn: ({ signal }) => {
            captured = signal;
            return new Promise<string>(() => {}); // never resolves
          },
        }),
      { wrapper: wrapper(qc) },
    );
    await waitFor(() => expect(captured).toBeDefined());
    expect(captured!.aborted).toBe(false);
    unmount();
    await waitFor(() => expect(captured!.aborted).toBe(true));
  });

  it("aborts the previous signal when the query key changes (supersede)", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const signals: Record<string, AbortSignal> = {};
    const { rerender } = renderHook(
      ({ k }: { k: string }) =>
        useQuery({
          queryKey: ["supersede", k],
          queryFn: ({ signal }) => {
            signals[k] = signal;
            return new Promise<string>(() => {});
          },
        }),
      { wrapper: wrapper(qc), initialProps: { k: "a" } },
    );
    await waitFor(() => expect(signals.a).toBeDefined());
    expect(signals.a!.aborted).toBe(false);
    rerender({ k: "b" });
    await waitFor(() => expect(signals.a!.aborted).toBe(true));
  });
});
