import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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

// Perturbation route tests moved to test/Perturbation.test.tsx after the
// B3 rebuild (correlation + scatter parity with Binding).
