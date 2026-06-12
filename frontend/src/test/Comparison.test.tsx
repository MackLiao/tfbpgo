import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useNavigate, useLocation } from "react-router-dom";
import { Comparison } from "@/routes/Comparison";
import { setArtifactVersion } from "@/api/client";

// PlotLazy dynamic-imports the (large) Plotly bundle and renders async. Stub it
// with a synchronous probe that surfaces the facet-title annotations the
// ComparisonBoxplot built, so the drill-down tests can assert WHICH distribution
// is shown without spinning up real Plotly.
type PlotProbe = { layout: Record<string, unknown> };
let lastPlot: PlotProbe | null = null;
vi.mock("@/plots/PlotLazy", () => ({
  PlotLazy: (props: PlotProbe) => {
    lastPlot = props;
    const titles =
      (props.layout?.annotations as Array<{ text: string }> | undefined)?.map(
        (a) => a.text,
      ) ?? [];
    return <div data-testid="drill-plot" data-facets={titles.join("|")} />;
  },
}));

// A mocked /comparison/topn response with two binding × two perturbation pairs,
// each carrying a single regulator row so the matrix median is deterministic:
//   callingcards__hackett   ratio 0.40 → 40.0%
//   callingcards__kemmeren  ratio 0.20 → 20.0%
//   harbison__hackett       ratio 0.60 → 60.0%
//   harbison__kemmeren      ratio 0.10 → 10.0%
const TOPN_ROWS = [
  {
    pairKey: "callingcards__hackett",
    bindingSampleId: "b",
    regulatorLocusTag: "R1",
    regulatorDisplayName: "R1",
    perturbationSampleId: "p",
    n: 25,
    nResponsive: 10,
    responsiveRatio: 0.4,
  },
  {
    pairKey: "callingcards__kemmeren",
    bindingSampleId: "b",
    regulatorLocusTag: "R1",
    regulatorDisplayName: "R1",
    perturbationSampleId: "p",
    n: 25,
    nResponsive: 5,
    responsiveRatio: 0.2,
  },
  {
    pairKey: "harbison__hackett",
    bindingSampleId: "b",
    regulatorLocusTag: "R1",
    regulatorDisplayName: "R1",
    perturbationSampleId: "p",
    n: 25,
    nResponsive: 15,
    responsiveRatio: 0.6,
  },
  {
    pairKey: "harbison__kemmeren",
    bindingSampleId: "b",
    regulatorLocusTag: "R1",
    regulatorDisplayName: "R1",
    perturbationSampleId: "p",
    n: 25,
    nResponsive: 2,
    responsiveRatio: 0.1,
  },
];

// Route fetches by path: /datasets → display-name map, /comparison/topn → rows.
function routedFetch(rows: unknown[] = TOPN_ROWS) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/datasets")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            datasets: [
              { dbName: "callingcards", displayName: "Calling Cards" },
              { dbName: "harbison", displayName: "Harbison" },
              { dbName: "hackett", displayName: "Hackett" },
              { dbName: "kemmeren", displayName: "Kemmeren" },
            ],
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ rows }), { status: 200 }));
  });
}

function renderComparison(initialEntry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Comparison />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Comparison route", () => {
  beforeEach(() => {
    lastPlot = null;
    setArtifactVersion("test");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ rows: [] }), { status: 200 })),
    );
  });

  it("renders the sidebar controls (Top N, responsiveness preset radios)", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/comparison"]}>
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("Top N")).toBeInTheDocument();
    // CMP-4/CMP-5: responsiveness-preset radios replace the old sliders
    expect(screen.getByDisplayValue("Relaxed")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Stringent")).toBeInTheDocument();
    // Old effect/pvalue sliders must NOT be present
    expect(screen.queryByLabelText("Min |effect|")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Max p-value")).not.toBeInTheDocument();
    // The vestigial "Facet by" radio was removed: the drill-down direction is
    // derived from which matrix header the user clicks (drill.facetBy), so the
    // sidebar control drove nothing. Guard against it reappearing.
    expect(screen.queryByLabelText("Binding source")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Perturbation source")).not.toBeInTheDocument();
  });

  it("defaults to Relaxed preset when no ?preset= param is in the URL", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/comparison"]}>
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const relaxedRadio = screen.getByDisplayValue("Relaxed") as HTMLInputElement;
    const stringentRadio = screen.getByDisplayValue("Stringent") as HTMLInputElement;
    expect(relaxedRadio.checked).toBe(true);
    expect(stringentRadio.checked).toBe(false);
  });

  it("reads ?preset=Stringent from the URL and selects the Stringent radio", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/comparison?preset=Stringent"]}>
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const stringentRadio = screen.getByDisplayValue("Stringent") as HTMLInputElement;
    expect(stringentRadio.checked).toBe(true);
  });

  it("selecting Stringent writes preset=Stringent into the URL state", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/comparison"]}>
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const stringentRadio = screen.getByDisplayValue("Stringent") as HTMLInputElement;
    expect(stringentRadio.checked).toBe(false);
    fireEvent.click(stringentRadio);
    await waitFor(() => expect(stringentRadio.checked).toBe(true));
    // Once Stringent is selected, Relaxed should be unchecked
    const relaxedRadio = screen.getByDisplayValue("Relaxed") as HTMLInputElement;
    expect(relaxedRadio.checked).toBe(false);
  });

  it("renders the empty-state prompt until both binding and perturbation are picked", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/comparison"]}>
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      screen.getByText(/Pick at least one binding and one perturbation dataset/),
    ).toBeInTheDocument();
  });

  it("shows the diagram-shaped loading skeleton while the top_n query is pending", () => {
    // A fetch that never resolves keeps the query in the pending state, which
    // is what the user sees during the multi-second top_n load on real data.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(new Promise<Response>(() => {})),
    );
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter
          initialEntries={[
            "/comparison?binding=callingcards&perturbation=hackett",
          ]}
        >
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      screen.getByLabelText("Loading comparison chart"),
    ).toBeInTheDocument();
  });

  it("renders the backend's readable message (not 'HTTP 400') when the top_n query is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error:
              "too many comparisons: 24 binding×perturbation pairs requested (max 6) — select fewer binding or perturbation datasets",
          }),
          { status: 400 },
        ),
      ),
    );
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter
          initialEntries={[
            "/comparison?binding=a,b,c,d&perturbation=e,f,g,h,i,j",
          ]}
        >
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText(/too many comparisons.*select fewer/),
    ).toBeInTheDocument();
    expect(screen.queryByText("HTTP 400")).not.toBeInTheDocument();
  });

  it("sends ?preset=Stringent to the API when Stringent is selected", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ rows: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter
          initialEntries={[
            "/comparison?binding=callingcards&perturbation=hackett&preset=Stringent",
          ]}
        >
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Wait for the query to fire
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const calledUrl: string = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("preset=Stringent");
    // Must NOT fall back to numeric effect/pvalue params
    expect(calledUrl).not.toContain("effect=");
    expect(calledUrl).not.toContain("pvalue=");
  });

  // ---------------------------------------------------------------------------
  // CMP-6 / Task 6a: 3-tab navset + Compare Datasets matrix + drill-down.
  // ---------------------------------------------------------------------------

  it("renders the three comparison tabs", () => {
    renderComparison("/comparison?binding=callingcards&perturbation=hackett");
    expect(screen.getByRole("tab", { name: "Compare Datasets" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Compare Promoter Definitions" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Compare Analysis Methods" }),
    ).toBeInTheDocument();
  });

  it("defaults to the Compare Datasets tab when ?tab= is absent", () => {
    renderComparison("/comparison?binding=callingcards&perturbation=hackett");
    expect(screen.getByRole("tab", { name: "Compare Datasets" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("falls back to the first tab for an unknown ?tab= value", () => {
    renderComparison(
      "/comparison?binding=callingcards&perturbation=hackett&tab=bogus",
    );
    expect(screen.getByRole("tab", { name: "Compare Datasets" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("activates the Compare Promoter Definitions tab from ?tab=promoters", () => {
    renderComparison(
      "/comparison?binding=callingcards&perturbation=hackett&tab=promoters",
    );
    expect(
      screen.getByRole("tab", { name: "Compare Promoter Definitions" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("switches tabs via click (URL ?tab= state)", async () => {
    renderComparison("/comparison?binding=callingcards&perturbation=hackett");
    fireEvent.click(screen.getByRole("tab", { name: "Compare Analysis Methods" }));
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Compare Analysis Methods" }),
      ).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("shows the variant-tab empty state when no eligible binding dataset is picked", async () => {
    vi.stubGlobal("fetch", routedFetch());
    // callingcards HAS promoter variants but NO peaks variant → the methods tab
    // shows its empty state, while the promoters tab renders a table.
    renderComparison(
      "/comparison?binding=callingcards&perturbation=hackett&tab=methods",
    );
    const empty = await screen.findByTestId("comparison-variant-empty");
    expect(
      within(empty).getByText(/original peaks calls/i),
    ).toBeInTheDocument();

    // Switching to the promoters tab renders a real per-perturbation table.
    fireEvent.click(
      screen.getByRole("tab", { name: "Compare Promoter Definitions" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("cp-tables")).toBeInTheDocument(),
    );
  });

  it("renders the matrix with median % cells from the topn response", async () => {
    vi.stubGlobal("fetch", routedFetch());
    renderComparison(
      "/comparison?binding=callingcards,harbison&perturbation=hackett,kemmeren",
    );
    // Wait for the topn query to land and the matrix to render.
    const cell = await screen.findByTestId("topn-cell-callingcards-hackett");
    expect(cell.textContent).toContain("40.0%");
    expect(
      screen.getByTestId("topn-cell-callingcards-kemmeren").textContent,
    ).toContain("20.0%");
    expect(
      screen.getByTestId("topn-cell-harbison-hackett").textContent,
    ).toContain("60.0%");
    expect(
      screen.getByTestId("topn-cell-harbison-kemmeren").textContent,
    ).toContain("10.0%");
    // Display names from /datasets drive the headers.
    expect(
      within(screen.getByTestId("topn-row-callingcards")).getByText("Calling Cards"),
    ).toBeInTheDocument();
  });

  it("clicking a binding row shows that binding's distribution (faceted by binding)", async () => {
    vi.stubGlobal("fetch", routedFetch());
    renderComparison(
      "/comparison?binding=callingcards,harbison&perturbation=hackett,kemmeren",
    );
    // No selection yet → prompt, no drill plot.
    await screen.findByTestId("topn-cell-callingcards-hackett");
    expect(screen.queryByTestId("drill-plot")).toBeNull();
    expect(
      screen.getByText(/Click a row header to view distributions/),
    ).toBeInTheDocument();

    // Click the harbison row header → drill into that binding.
    fireEvent.click(
      within(screen.getByTestId("topn-row-harbison")).getByRole("button"),
    );
    const plot = await screen.findByTestId("drill-plot");
    // Faceted by binding → the single facet is the harbison label.
    expect(plot.getAttribute("data-facets")).toBe("2004 ChIP-chip");
  });

  it("clicking a perturbation column shows that column's distribution (faceted by perturbation)", async () => {
    vi.stubGlobal("fetch", routedFetch());
    renderComparison(
      "/comparison?binding=callingcards,harbison&perturbation=hackett,kemmeren",
    );
    await screen.findByTestId("topn-cell-callingcards-hackett");

    // Click the kemmeren column header → drill into that perturbation.
    fireEvent.click(
      within(screen.getByTestId("topn-col-kemmeren")).getByRole("button"),
    );
    const plot = await screen.findByTestId("drill-plot");
    // Faceted by perturbation → the single facet is the kemmeren label.
    expect(plot.getAttribute("data-facets")).toBe("2014 TFKO");
  });

  // ---------------------------------------------------------------------------
  // LOW: a stale drill-down pick must reset when its dataset leaves ?binding= /
  // ?perturbation=. The selection is ephemeral component state that survives URL
  // changes, so without validation the matrix would render an empty distribution
  // with no explanation. Mirrors Binding.tsx pruning committed pairs.
  // ---------------------------------------------------------------------------
  it("resets the drill-down when the selected binding dataset leaves ?binding=", async () => {
    vi.stubGlobal("fetch", routedFetch());
    // A small harness that renders Comparison plus a button that rewrites the
    // URL (the equivalent of the user deselecting `harbison` on the Select page).
    function Harness() {
      const navigate = useNavigate();
      return (
        <>
          <button
            type="button"
            onClick={() =>
              navigate(
                "/comparison?binding=callingcards&perturbation=hackett,kemmeren",
              )
            }
          >
            drop-harbison
          </button>
          <Comparison />
        </>
      );
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter
          initialEntries={[
            "/comparison?binding=callingcards,harbison&perturbation=hackett,kemmeren",
          ]}
        >
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Drill into the harbison binding row.
    await screen.findByTestId("topn-cell-callingcards-hackett");
    fireEvent.click(
      within(screen.getByTestId("topn-row-harbison")).getByRole("button"),
    );
    await screen.findByTestId("drill-plot");

    // Now remove harbison from the URL. The ?binding= change re-keys the topn
    // query (brief skeleton), then the matrix re-renders without the harbison
    // row. The stale drill-down pick must clear: no empty distribution lingers.
    fireEvent.click(screen.getByText("drop-harbison"));
    // Wait for the refetched matrix to settle (callingcards row still present,
    // harbison row gone).
    await waitFor(() => {
      expect(screen.getByTestId("topn-row-callingcards")).toBeInTheDocument();
      expect(screen.queryByTestId("topn-row-harbison")).toBeNull();
    });
    // The stale drill-down is cleared: the prompt returns, no empty plot.
    expect(screen.queryByTestId("drill-plot")).toBeNull();
    expect(
      screen.getByText(/Click a row header to view distributions/),
    ).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Promoter-set selector on the Compare Promoter Definitions tab
  // (reference cp_included_promoter_sets — workspace.py:552-568). DEFAULT all
  // four selected (absent ?promoterSets=); unchecking one writes the param +
  // drops that column; re-checking all clears the param again.
  // ---------------------------------------------------------------------------
  it("promoter-set selector defaults to all four checked; unchecking one drops its column + writes the URL; re-checking all clears the param", async () => {
    vi.stubGlobal("fetch", routedFetch());
    function LocationProbe() {
      const loc = useLocation();
      return <div data-testid="loc-search">{loc.search}</div>;
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter
          initialEntries={[
            // callingcards is a variant-bearing primary → the cp table renders.
            "/comparison?binding=callingcards&perturbation=hackett&tab=promoters",
          ]}
        >
          <Comparison />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Four checkboxes, all checked by default (param absent => all selected).
    const card = await screen.findByTestId("cp-card-hackett");
    const kang = screen.getByLabelText("Promoter Set 1 (Kang)") as HTMLInputElement;
    const mindel = screen.getByLabelText(
      "Promoter Set 2 (Mindel)",
    ) as HTMLInputElement;
    const fiveHundred = screen.getByLabelText(
      "Promoter Set 3 (500bp)",
    ) as HTMLInputElement;
    const intergenic = screen.getByLabelText(
      "Promoter Set 4 (Intergenic)",
    ) as HTMLInputElement;
    expect(kang.checked).toBe(true);
    expect(mindel.checked).toBe(true);
    expect(fiveHundred.checked).toBe(true);
    expect(intergenic.checked).toBe(true);
    // All four columns render initially.
    expect(within(card).getByText("Mindel")).toBeInTheDocument();

    // Uncheck Mindel → ?promoterSets=Kang,500bp,Intergenic (no Mindel) AND the
    // Mindel column disappears from the cp table.
    fireEvent.click(mindel);
    await waitFor(() => {
      const search = screen.getByTestId("loc-search").textContent ?? "";
      expect(search).toContain("promoterSets=");
      const value = new URLSearchParams(search).get("promoterSets") ?? "";
      const sets = value.split(",");
      expect(sets).not.toContain("Mindel");
      expect(sets).toEqual(["Kang", "500bp", "Intergenic"]);
    });
    await waitFor(() =>
      expect(
        within(screen.getByTestId("cp-card-hackett")).queryByText("Mindel"),
      ).toBeNull(),
    );

    // Re-check Mindel → back to all four → the param is cleared (clean URL).
    fireEvent.click(screen.getByLabelText("Promoter Set 2 (Mindel)"));
    await waitFor(() => {
      const search = screen.getByTestId("loc-search").textContent ?? "";
      expect(new URLSearchParams(search).has("promoterSets")).toBe(false);
    });
    // Mindel column is back.
    expect(
      within(screen.getByTestId("cp-card-hackett")).getByText("Mindel"),
    ).toBeInTheDocument();
  });
});
