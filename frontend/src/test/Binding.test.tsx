import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { Binding } from "@/routes/Binding";
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
    // BIND-5/BIND-6: first-load defaults are now spearman + log10pval.
    expect(corrCall!).toContain("method=spearman");
    expect(corrCall!).toContain("col=log10pval");
  });

  it("Pearson radio click writes ?corr=pearson to the URL (spearman is the new default)", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.includes("/binding/corr"))
          return { method: "spearman", col: "log10pval", pairs: [] };
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

    // Spearman is the default now, so clicking it would be a no-op on the URL.
    // Click Pearson to move OFF the default and assert the URL records it.
    const pearson = screen.getByLabelText(/Pearson/i);
    fireEvent.click(pearson);

    await waitFor(() => {
      expect(screen.getByTestId("loc-search").textContent).toMatch(
        /corr=pearson/,
      );
    });
  });

  it("renders the -log10(p-value) measurement radio, selected by default", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.includes("/binding/corr"))
          return { method: "spearman", col: "log10pval", pairs: [] };
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

    const log10 = screen.getByLabelText(/-log10\(p-value\)/i) as HTMLInputElement;
    expect(log10).toBeInTheDocument();
    expect(log10.checked).toBe(true);
  });

  it("renders the ActivePairRegulatorPicker narrowed to corr-response regulators once corr data is loaded", async () => {
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
                    correlation: 0.5,
                  },
                  {
                    dbA: "callingcards",
                    dbAId: "cc_1",
                    dbB: "hackett",
                    dbBId: "h_1",
                    regulatorLocusTag: "YAL001C",
                    correlation: 0.2,
                  },
                ],
              },
            ],
          };
        }
        if (url.includes("/sample-conditions")) {
          return { dbName: "x", conditionCols: [], labels: {} };
        }
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

    // Once corrQuery.data resolves, the sidebar must replace the global
    // typeahead RegulatorPicker (which has an Input with this exact
    // placeholder) with the narrowed <select> (small set < 50).
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText(/search regulator/i),
      ).not.toBeInTheDocument();
    });
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    const optionValues = Array.from(select.options).map((o) => o.value);
    // Alphabetized by case-insensitive label; "YAL001C" < "YBR289W".
    expect(optionValues).toContain("YBR289W");
    expect(optionValues).toContain("YAL001C");
  });

  it("auto-selects the first regulator (sorted) into the URL when none is set (B-3)", async () => {
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
            regulatorDisplay: {},
            pairs: [
              {
                dbA: "callingcards",
                dbB: "hackett",
                colA: "callingcards_enrichment",
                colB: "effect",
                points: [
                  { dbA: "callingcards", dbAId: "cc_0", dbB: "hackett", dbBId: "h_0", regulatorLocusTag: "YBR289W", correlation: 0.5 },
                  { dbA: "callingcards", dbAId: "cc_1", dbB: "hackett", dbBId: "h_1", regulatorLocusTag: "YAL001C", correlation: 0.2 },
                ],
              },
            ],
          };
        }
        if (url.includes("/sample-conditions")) return { dbName: "x", conditionCols: [], labels: {} };
        if (url.includes("/binding/scatter"))
          return { regulator: "YAL001C", dbA: "callingcards", dbB: "hackett", colA: "callingcards_enrichment", colB: "effect", method: "pearson", r: 0, points: [] };
        return {};
      }),
    );

    function LocationProbe() {
      const loc = useLocation();
      return <div data-testid="loc-search">{loc.search}</div>;
    }

    render(
      <QueryClientProvider client={makeClient()}>
        {/* No ?regulator= in the URL. */}
        <MemoryRouter initialEntries={["/binding?binding=callingcards,hackett"]}>
          <Routes>
            <Route path="/binding" element={<><Binding /><LocationProbe /></>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Once corr loads, the effect writes the first sorted regulator. With an
    // empty display map the sort is by locus tag (case-insensitive), so
    // "YAL001C" < "YBR289W" → regulator=YAL001C.
    await waitFor(() => {
      expect(screen.getByTestId("loc-search").textContent).toMatch(/regulator=YAL001C/);
    });
  });

  it("renders the boxplot (2 traces) on the Pair Distribution tab only after a pair is committed via ?pairs=", async () => {
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
            regulatorDisplay: {},
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
        {/* Deep-link a committed pair AND land on the distribution tab. */}
        <MemoryRouter
          initialEntries={[
            "/binding?binding=callingcards,hackett&regulator=YBR289W&pairs=callingcards__hackett&tab=distribution",
          ]}
        >
          <Binding />
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

describe("Binding correlation-matrix pair selection (BIND-2)", () => {
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
      if (url.includes("/binding/corr")) {
        return {
          method: "spearman",
          col: "log10pval",
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
      if (url.includes("/binding/scatter"))
        return {
          regulator: "YAL001C",
          dbA: "aaa",
          dbB: "bbb",
          colA: "a",
          colB: "b",
          method: "spearman",
          r: 0.2,
          points: [],
          axisLabelA: "rank by p-value",
          axisLabelB: "rank by p-value",
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
        <MemoryRouter initialEntries={["/binding?binding=aaa,bbb,ccc"]}>
          <Binding />
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
    // in row bbb (corr-cell-bbb-bbb — aaa is only a row label, never a column)
    // has none.
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
        <MemoryRouter initialEntries={["/binding?binding=aaa,bbb,ccc"]}>
          <Binding />
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
        <MemoryRouter initialEntries={["/binding?binding=aaa,bbb,ccc"]}>
          <Routes>
            <Route path="/binding" element={<><Binding /><LocationProbe /></>} />
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
      // One box for the single committed pair (overlay may or may not be present
      // depending on the selected regulator) — at least the box trace exists.
      expect(Number(plot!.getAttribute("data-trace-count"))).toBeGreaterThanOrEqual(1);
    });
  });

  it("Pair Distribution and Gene Scatter tabs show an empty-state hint when nothing is committed", async () => {
    vi.stubGlobal("fetch", fakeFetch(threeDatasetFetch()));

    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/binding?binding=aaa,bbb,ccc&tab=distribution"]}>
          <Binding />
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
});

// Perturbation route tests moved to test/Perturbation.test.tsx after the
// B3 rebuild (correlation + scatter parity with Binding).
