import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { Binding } from "@/routes/Binding";
import { Perturbation } from "@/routes/Perturbation";
import { setArtifactVersion } from "@/api/client";

// Stub PlotLazy — actual Plotly rendering is jsdom-incompatible and would
// dominate test time. The point of these tests is the URL→fetch contract
// and the radio-click → URL-write contract, not Plotly internals.
vi.mock("@/plots/PlotLazy", () => ({
  PlotLazy: (props: { data?: unknown[]; layout?: unknown; onClick?: unknown }) => (
    <div
      data-testid="plotly"
      data-trace-count={Array.isArray(props.data) ? props.data.length : 0}
      data-has-onclick={props.onClick ? "yes" : "no"}
    />
  ),
}));

function fakeFetch(handler: (url: string) => unknown) {
  return vi.fn((url: string) =>
    Promise.resolve(
      new Response(JSON.stringify(handler(url) ?? {}), { status: 200 }),
    ),
  );
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("Binding route URL keys", () => {
  beforeEach(() => {
    setArtifactVersion("test");
  });

  it("shows the 'select 2+ datasets' empty state when fewer than two datasets are selected", () => {
    vi.stubGlobal("fetch", fakeFetch(() => ({ datasets: [] })));

    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/binding"]}>
          <Binding />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      screen.getByText(/Select at least two binding datasets/i),
    ).toBeInTheDocument();
  });

  it("fires /binding/corr with the active datasets when >= 2 are selected", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        calls.push(url);
        if (url.includes("/binding/corr"))
          return { method: "pearson", col: "effect", pairs: [] };
        if (url.endsWith("/datasets")) return { datasets: [] };
        return {};
      }),
    );

    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/binding?binding=callingcards,hackett"]}>
          <Binding />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(calls.some((u) => u.includes("/binding/corr"))).toBe(true);
    });
    const corrCall = calls.find((u) => u.includes("/binding/corr"));
    expect(corrCall).toBeDefined();
    expect(corrCall!).toContain("datasets=callingcards%2Chackett");
    expect(corrCall!).toContain("method=pearson");
    expect(corrCall!).toContain("col=effect");
  });

  it("Spearman radio click writes ?corr=spearman to the URL", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.includes("/binding/corr"))
          return { method: "pearson", col: "effect", pairs: [] };
        if (url.endsWith("/datasets")) return { datasets: [] };
        return {};
      }),
    );

    function LocationProbe() {
      const loc = useLocation();
      return <div data-testid="loc-search">{loc.search}</div>;
    }

    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/binding?binding=callingcards,hackett"]}>
          <Routes>
            <Route
              path="/binding"
              element={
                <>
                  <Binding />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const spearman = screen.getByLabelText(/Spearman/i);
    fireEvent.click(spearman);

    await waitFor(() => {
      expect(screen.getByTestId("loc-search").textContent).toMatch(
        /corr=spearman/,
      );
    });
  });

  it("renders the correlation boxplot trace + selected-regulator overlay when corr data is present", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.endsWith("/datasets")) {
          return {
            datasets: [
              { dbName: "callingcards", displayName: "Calling Cards" },
              { dbName: "hackett", displayName: "Hackett" },
            ],
          };
        }
        if (url.includes("/binding/corr")) {
          return {
            method: "pearson",
            col: "effect",
            pairs: [
              {
                dbA: "callingcards",
                dbB: "hackett",
                colA: "callingcards_enrichment",
                colB: "effect",
                points: [
                  {
                    dbA: "callingcards",
                    dbAId: "cc_0",
                    dbB: "hackett",
                    dbBId: "h_0",
                    regulatorLocusTag: "YBR289W",
                    correlation: 0.42,
                  },
                ],
              },
            ],
          };
        }
        if (url.includes("/binding/scatter"))
          return {
            regulator: "YBR289W",
            dbA: "callingcards",
            dbB: "hackett",
            colA: "callingcards_enrichment",
            colB: "effect",
            method: "pearson",
            r: 0,
            points: [],
          };
        return {};
      }),
    );

    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter
          initialEntries={[
            "/binding?binding=callingcards,hackett&regulator=YBR289W",
          ]}
        >
          <Binding />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Wait for the boxplot's PlotLazy to mount with 2 traces:
    //   one go.Box for the pair + one go.Scatter overlay for the selected regulator.
    await waitFor(() => {
      const plot = screen.queryByTestId("plotly");
      expect(plot).not.toBeNull();
      expect(plot!.getAttribute("data-trace-count")).toBe("2");
      expect(plot!.getAttribute("data-has-onclick")).toBe("yes");
    });
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
      fakeFetch((url) => {
        calls.push(url);
        return { datasets: [] };
      }),
    );

    render(
      <QueryClientProvider client={makeClient()}>
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
