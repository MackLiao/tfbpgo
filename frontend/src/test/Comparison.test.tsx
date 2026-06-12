import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
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
//   callingcards__hackett   ratio 0.40 → 40%
//   callingcards__kemmeren  ratio 0.20 → 20%
//   harbison__hackett       ratio 0.60 → 60%
//   harbison__kemmeren      ratio 0.10 → 10%
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

  it("renders the sidebar controls (Top N, responsiveness preset radios, facet radios)", () => {
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
    // Facet radios remain
    expect(screen.getByLabelText("Binding source")).toBeInTheDocument();
    expect(screen.getByLabelText("Perturbation source")).toBeInTheDocument();
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

  it("toggling facet_by radio writes to the URL", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/comparison?binding=callingcards&perturbation=hackett"]}>
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const pertRadio = screen.getByLabelText("Perturbation source") as HTMLInputElement;
    expect(pertRadio.checked).toBe(false);
    fireEvent.click(pertRadio);
    await waitFor(() => expect(pertRadio.checked).toBe(true));
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

  it("renders the placeholder tabs without crashing", async () => {
    renderComparison(
      "/comparison?binding=callingcards&perturbation=hackett&tab=promoters",
    );
    const panel = await screen.findByTestId("comparison-coming-soon");
    expect(panel).toBeInTheDocument();
    expect(
      within(panel).getByText(/promoter enrichment scores across promoter set/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Compare Analysis Methods" }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("comparison-coming-soon")).getByText(
          /promoter enrichment vs\. original peaks scoring/i,
        ),
      ).toBeInTheDocument(),
    );
  });

  it("renders the matrix with median % cells from the topn response", async () => {
    vi.stubGlobal("fetch", routedFetch());
    renderComparison(
      "/comparison?binding=callingcards,harbison&perturbation=hackett,kemmeren",
    );
    // Wait for the topn query to land and the matrix to render.
    const cell = await screen.findByTestId("topn-cell-callingcards-hackett");
    expect(cell.textContent).toContain("40%");
    expect(
      screen.getByTestId("topn-cell-callingcards-kemmeren").textContent,
    ).toContain("20%");
    expect(
      screen.getByTestId("topn-cell-harbison-hackett").textContent,
    ).toContain("60%");
    expect(
      screen.getByTestId("topn-cell-harbison-kemmeren").textContent,
    ).toContain("10%");
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
});
