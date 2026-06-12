// Tests for HOME-3: the "Datasets loading" banner shown while the top-level
// /datasets query is pending on first paint.
//
// Strategy: mock the `api.datasets` call and control whether it resolves, so
// we can assert the banner appears while pending and disappears once settled.
// The Layout component uses TanStack Query — we wrap it with a QueryClient
// configured for immediate retries disabled (retry: false) so the settled
// state is reached predictably.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { setArtifactVersion } from "@/api/client";

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("Layout datasets loading banner (HOME-3)", () => {
  beforeEach(() => {
    setArtifactVersion("test");
  });

  it("shows the 'Datasets loading' banner while the datasets query is pending", () => {
    // Never-resolving fetch keeps the query in the pending state.
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>(() => {})));

    render(
      <QueryClientProvider client={makeQC()}>
        <MemoryRouter>
          <Layout>
            <div>content</div>
          </Layout>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const banner = screen.getByTestId("datasets-loading-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/Datasets loading/);
    expect(banner).toHaveTextContent(/less than 5 seconds/);
    expect(banner).toHaveTextContent(/Thank you for your patience/);
  });

  it("hides the banner once the datasets query resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ datasets: [] }), { status: 200 }),
      ),
    );

    render(
      <QueryClientProvider client={makeQC()}>
        <MemoryRouter>
          <Layout>
            <div>content</div>
          </Layout>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Banner appears immediately while fetch is in flight.
    expect(screen.getByTestId("datasets-loading-banner")).toBeInTheDocument();

    // Once the fetch resolves the query settles and isPending becomes false.
    await waitFor(() =>
      expect(screen.queryByTestId("datasets-loading-banner")).not.toBeInTheDocument(),
    );
  });
});
