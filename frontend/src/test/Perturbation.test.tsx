import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { Perturbation } from "@/routes/Perturbation";
import { setArtifactVersion } from "@/api/client";

// Mirrors test/Binding.test.tsx. Stub PlotLazy — actual Plotly rendering is
// jsdom-incompatible and would dominate test time. The point of these tests
// is the URL→fetch contract and the radio-click → URL-write contract, not
// Plotly internals.
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

describe("Perturbation route URL keys", () => {
  beforeEach(() => {
    setArtifactVersion("test");
  });

  it("shows the 'select 2+ datasets' empty state when fewer than two datasets are selected", () => {
    vi.stubGlobal("fetch", fakeFetch(() => ({ datasets: [] })));

    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/perturbation"]}>
          <Perturbation />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      screen.getByText(/Select at least two perturbation datasets/i),
    ).toBeInTheDocument();
  });

  it("fires /perturbation/correlations with the active datasets when >= 2 are selected", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        calls.push(url);
        if (url.includes("/perturbation/correlations"))
          return { method: "pearson", col: "effect", pairs: [] };
        if (url.endsWith("/datasets")) return { datasets: [] };
        return {};
      }),
    );

    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/perturbation?perturbation=hackett,kemmeren"]}>
          <Perturbation />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(calls.some((u) => u.includes("/perturbation/correlations"))).toBe(true);
    });
    const corrCall = calls.find((u) => u.includes("/perturbation/correlations"));
    expect(corrCall).toBeDefined();
    expect(corrCall!).toContain("datasets=hackett%2Ckemmeren");
    // PERT-1: the perturbation module keeps effect / pearson defaults (UNLIKE
    // binding, which switched to log10pval / spearman). Reference
    // perturbation/ui.py:41 selected="effect", :49 selected="pearson".
    expect(corrCall!).toContain("method=pearson");
    expect(corrCall!).toContain("col=effect");
  });

  it("Spearman radio click writes ?corr=spearman to the URL (pearson is the default)", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.includes("/perturbation/correlations"))
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
        <MemoryRouter initialEntries={["/perturbation?perturbation=hackett,kemmeren"]}>
          <Routes>
            <Route
              path="/perturbation"
              element={
                <>
                  <Perturbation />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Pearson is the default for perturbation, so click Spearman to move OFF it.
    const spearman = screen.getByLabelText(/Spearman/i);
    fireEvent.click(spearman);

    await waitFor(() => {
      expect(screen.getByTestId("loc-search").textContent).toMatch(
        /corr=spearman/,
      );
    });
  });

  it("offers the -log10(p-value) measurement radio (not the default; effect is)", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.includes("/perturbation/correlations"))
          return { method: "pearson", col: "effect", pairs: [] };
        if (url.endsWith("/datasets")) return { datasets: [] };
        return {};
      }),
    );

    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/perturbation?perturbation=hackett,kemmeren"]}>
          <Perturbation />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // The log10pval option exists (ui.py:27-29) but is NOT the default;
    // perturbation defaults to Effect.
    const log10 = screen.getByLabelText(/-log10\(p-value\)/i) as HTMLInputElement;
    expect(log10).toBeInTheDocument();
    expect(log10.checked).toBe(false);
    const effect = screen.getByLabelText(/^Effect$/i) as HTMLInputElement;
    expect(effect.checked).toBe(true);
  });

  it("renders the boxplot (2 traces) on the Pair Distribution tab only after a pair is committed via ?pairs=", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.endsWith("/datasets")) {
          return {
            datasets: [
              { dbName: "hackett", displayName: "Hackett" },
              { dbName: "kemmeren", displayName: "Kemmeren" },
            ],
          };
        }
        if (url.includes("/perturbation/correlations")) {
          return {
            method: "pearson",
            col: "effect",
            regulatorDisplay: {},
            pairs: [
              {
                dbA: "hackett",
                dbB: "kemmeren",
                colA: "effect",
                colB: "effect",
                points: [
                  {
                    dbA: "hackett",
                    dbAId: "h_0",
                    dbB: "kemmeren",
                    dbBId: "k_0",
                    regulatorLocusTag: "YBR289W",
                    correlation: 0.37,
                  },
                ],
              },
            ],
          };
        }
        if (url.includes("/perturbation/scatter"))
          return {
            regulator: "YBR289W",
            dbA: "hackett",
            dbB: "kemmeren",
            colA: "effect",
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
        {/* Deep-link a committed pair AND land on the distribution tab. */}
        <MemoryRouter
          initialEntries={[
            "/perturbation?perturbation=hackett,kemmeren&regulator=YBR289W&pairs=hackett__kemmeren&tab=distribution",
          ]}
        >
          <Perturbation />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Wait for the boxplot's PlotLazy to mount with 2 traces:
    //   one go.Box for the committed pair + one go.Scatter overlay for the
    //   selected regulator.
    await waitFor(() => {
      const plot = screen.queryByTestId("plotly");
      expect(plot).not.toBeNull();
      expect(plot!.getAttribute("data-trace-count")).toBe("2");
      expect(plot!.getAttribute("data-has-onclick")).toBe("yes");
    });
  });
});

describe("Perturbation correlation-matrix pair selection (PERT-2)", () => {
  beforeEach(() => {
    setArtifactVersion("test");
  });

  // Three-dataset corr fixture so the upper-triangle matrix has multiple
  // interactive cells (and at least one empty lower-triangle cell). Each pair's
  // single point's correlation is the median displayed in its cell.
  function threeDatasetFetch(): (url: string) => unknown {
    return (url) => {
      if (url.endsWith("/datasets")) {
        return {
          datasets: [
            { dbName: "aaa", displayName: "AAA" },
            { dbName: "bbb", displayName: "BBB" },
            { dbName: "ccc", displayName: "CCC" },
          ],
        };
      }
      if (url.includes("/perturbation/correlations")) {
        return {
          method: "pearson",
          col: "effect",
          regulatorDisplay: {},
          pairs: [
            mkPair("aaa", "bbb", [0.1, 0.3]), // median 0.2
            mkPair("aaa", "ccc", [0.5]), //       median 0.5
            mkPair("bbb", "ccc", [0.4, 0.6, 0.8]), // median 0.6
          ],
        };
      }
      if (url.includes("/sample-conditions"))
        return { dbName: "x", conditionCols: [], labels: {} };
      if (url.includes("/perturbation/scatter"))
        return {
          regulator: "YAL001C",
          dbA: "aaa",
          dbB: "bbb",
          colA: "a",
          colB: "b",
          method: "pearson",
          r: 0.2,
          points: [],
        };
      return {};
    };
  }

  function mkPair(dbA: string, dbB: string, corrs: number[]) {
    return {
      dbA,
      dbB,
      colA: `${dbA}_col`,
      colB: `${dbB}_col`,
      points: corrs.map((c, i) => ({
        dbA,
        dbAId: `${dbA}_${i}`,
        dbB,
        dbBId: `${dbB}_${i}`,
        regulatorLocusTag: i === 0 ? "YAL001C" : "YBR289W",
        correlation: c,
      })),
    };
  }

  it("renders interactive cells with the per-pair median correlation and a non-interactive lower-triangle cell", async () => {
    vi.stubGlobal("fetch", fakeFetch(threeDatasetFetch()));

    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/perturbation?perturbation=aaa,bbb,ccc"]}>
          <Perturbation />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Upper-triangle cells show the median; assert one of each median value.
    await waitFor(() => {
      expect(screen.getByTestId("corr-cell-aaa-bbb")).toBeInTheDocument();
    });
    expect(screen.getByTestId("corr-cell-aaa-bbb").textContent).toContain("0.200");
    expect(screen.getByTestId("corr-cell-aaa-ccc").textContent).toContain("0.500");
    expect(screen.getByTestId("corr-cell-bbb-ccc").textContent).toContain("0.600");

    // Interactive cells carry a button; the lower-triangle/diagonal placeholder
    // in row bbb (corr-cell-bbb-bbb) has none.
    expect(
      screen.getByTestId("corr-cell-aaa-bbb").getAttribute("data-interactive"),
    ).toBe("true");
    expect(
      screen.getByTestId("corr-cell-bbb-bbb").getAttribute("data-interactive"),
    ).toBe("false");
    expect(
      within(screen.getByTestId("corr-cell-bbb-bbb")).queryByRole("button"),
    ).toBeNull();
  });

  it("clicking a cell toggles its pending highlight without committing (boxplot stays empty)", async () => {
    vi.stubGlobal("fetch", fakeFetch(threeDatasetFetch()));

    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/perturbation?perturbation=aaa,bbb,ccc"]}>
          <Perturbation />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("corr-cell-aaa-bbb")).toBeInTheDocument();
    });

    const cell = screen.getByTestId("corr-cell-aaa-bbb");
    // Not selected initially.
    expect(cell.getAttribute("data-selected")).toBeNull();

    fireEvent.click(within(cell).getByRole("button"));
    // Pending highlight on; still nothing committed → "Selection changed" hint.
    await waitFor(() => {
      expect(
        screen.getByTestId("corr-cell-aaa-bbb").getAttribute("data-selected"),
      ).toBe("true");
    });
    expect(screen.getByText(/Selection changed/i)).toBeInTheDocument();

    // Click again to toggle off.
    fireEvent.click(within(screen.getByTestId("corr-cell-aaa-bbb")).getByRole("button"));
    await waitFor(() => {
      expect(
        screen.getByTestId("corr-cell-aaa-bbb").getAttribute("data-selected"),
      ).toBeNull();
    });
  });

  it("Execute Analysis commits the pending pair to ?pairs= and the distribution tab then renders the boxplot", async () => {
    vi.stubGlobal("fetch", fakeFetch(threeDatasetFetch()));

    function LocationProbe() {
      const loc = useLocation();
      return <div data-testid="loc-search">{loc.search}</div>;
    }

    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/perturbation?perturbation=aaa,bbb,ccc"]}>
          <Routes>
            <Route path="/perturbation" element={<><Perturbation /><LocationProbe /></>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("corr-cell-aaa-bbb")).toBeInTheDocument();
    });

    // Select the (aaa,bbb) pair, then Execute Analysis.
    fireEvent.click(within(screen.getByTestId("corr-cell-aaa-bbb")).getByRole("button"));
    fireEvent.click(screen.getByRole("button", { name: /Execute Analysis/i }));

    // ?pairs=aaa__bbb is written to the URL.
    await waitFor(() => {
      expect(screen.getByTestId("loc-search").textContent).toMatch(
        /pairs=aaa__bbb/,
      );
    });

    // Move to the Pair Distribution tab — the boxplot now mounts for the
    // committed pair (1 box trace + 1 overlay because YAL001C is auto-selected).
    fireEvent.click(screen.getByRole("tab", { name: /Pair Distribution/i }));
    await waitFor(() => {
      const plot = screen.queryByTestId("plotly");
      expect(plot).not.toBeNull();
      expect(Number(plot!.getAttribute("data-trace-count"))).toBeGreaterThanOrEqual(1);
    });
  });

  it("Pair Distribution and Gene Scatter tabs show an empty-state hint when nothing is committed", async () => {
    vi.stubGlobal("fetch", fakeFetch(threeDatasetFetch()));

    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/perturbation?perturbation=aaa,bbb,ccc&tab=distribution"]}>
          <Perturbation />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // The active tabpanel (Pair Distribution) shows the empty-state hint. Scope
    // to the tabpanel so the intro paragraph (which shares similar wording)
    // does not collide.
    await waitFor(() => {
      const panel = screen.getByRole("tabpanel");
      expect(
        within(panel).getByText(
          /Select cells in the Correlation Matrix and click Execute Analysis to view their distributions/i,
        ),
      ).toBeInTheDocument();
    });
    // No plot rendered while nothing is committed.
    expect(screen.queryByTestId("plotly")).toBeNull();
  });

  it("falls back to the Correlation Matrix tab when ?tab= is an unknown value", async () => {
    vi.stubGlobal("fetch", fakeFetch(threeDatasetFetch()));

    render(
      <QueryClientProvider client={makeClient()}>
        {/* Garbage tab value must not leave every panel hidden. */}
        <MemoryRouter initialEntries={["/perturbation?perturbation=aaa,bbb,ccc&tab=foo"]}>
          <Perturbation />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // The matrix panel is active (its table renders) and its trigger is the
    // selected tab — confirming the unknown value clamped to "matrix".
    await waitFor(() => {
      expect(screen.getByTestId("corr-matrix")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("tab", { name: /Correlation Matrix/i }),
    ).toHaveAttribute("aria-selected", "true");
  });
});
