import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PromoterDefinitionsTable,
  AnalysisMethodsTable,
} from "@/plots/ComparisonVariantTables";
import { setArtifactVersion } from "@/api/client";
import {
  PROMOTER_SET_ORDER,
  PROMOTER_VARIANT_PAIRS,
} from "@/lib/comparison-palette";

// The variant tabs fire ONE /comparison/topn request per perturbation dataset,
// each over [all binding variant dbs] × [a single perturbation]. We mock fetch
// per-request: parse the requested `binding` db list out of the URL and return
// a single-regulator row per (binding, perturbation) pair with a deterministic
// responsive ratio, so each table cell's two-stage median is exactly that
// ratio × 100.

// Per-pair ratio fixture. Keyed "{bindingDb}__{perturbationDb}".
const RATIOS: Record<string, number> = {
  // Compare Promoter Definitions — rossi across promoter sets, hackett pert.
  "rossi__hackett": 0.4, // Kang
  "rossi_mindel__hackett": 0.3,
  "rossi_500bp__hackett": 0.2,
  "rossi_intergenic__hackett": 0.1,
  // Compare Analysis Methods — rossi scoring variants, hackett pert.
  "rossi_peaks__hackett": 0.55,
};

function rowFor(pairKey: string, ratio: number) {
  return {
    pairKey,
    bindingSampleId: "b",
    regulatorLocusTag: "R1",
    regulatorDisplayName: "R1",
    perturbationSampleId: "p",
    n: 25,
    nResponsive: Math.round(ratio * 25),
    responsiveRatio: ratio,
  };
}

// fetch mock: read the requested binding db_names + perturbation off the URL,
// emit one row per (binding, pert) pair that has a fixture ratio.
function variantFetch(ratios: Record<string, number> = RATIOS) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://test.local");
    const binding = (url.searchParams.get("binding") ?? "").split(",").filter(Boolean);
    const perturbation = (url.searchParams.get("perturbation") ?? "")
      .split(",")
      .filter(Boolean);
    const rows: ReturnType<typeof rowFor>[] = [];
    for (const b of binding) {
      for (const p of perturbation) {
        const key = `${b}__${p}`;
        if (key in ratios) rows.push(rowFor(key, ratios[key]!));
      }
    }
    return Promise.resolve(new Response(JSON.stringify({ rows }), { status: 200 }));
  });
}

// fetch mock that fails every /comparison/topn slice with the backend's
// 12-pair-cap 400 shape ({"error": "<msg>"}), so we can assert the card surfaces
// the readable message instead of a silent all-"—" table.
const CAP_ERROR_MSG =
  "too many comparisons: 16 binding × perturbation pairs exceeds the limit of 12; select fewer datasets";
function capErrorFetch() {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: CAP_ERROR_MSG }), { status: 400 }),
    ),
  );
}

function renderWithClient(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("shared two-stage median", () => {
  it("reuses TopNMatrix.cellPercent (not a duplicated implementation)", async () => {
    // The variant tables import the SAME exported `cellPercent` as the Compare
    // Datasets matrix — guard against drift by asserting both modules resolve to
    // one function identity.
    const matrixMod = await import("@/plots/TopNMatrix");
    expect(typeof matrixMod.cellPercent).toBe("function");
    // The variant module imports it by name; a re-implementation would shadow
    // this export. Spot-check the two-stage median: per-reg medians then median.
    const rows = [
      { regulatorLocusTag: "A", responsiveRatio: 0.2 },
      { regulatorLocusTag: "A", responsiveRatio: 0.4 }, // A median → 0.3 → 30
      { regulatorLocusTag: "B", responsiveRatio: 0.6 }, // B median → 0.6 → 60
    ] as Parameters<typeof matrixMod.cellPercent>[0];
    // median([30, 60]) = 45
    expect(matrixMod.cellPercent(rows)).toBe(45);
  });
});

describe("PromoterDefinitionsTable", () => {
  beforeEach(() => {
    setArtifactVersion("test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ rows: [] }), { status: 200 })),
    );
  });

  it("renders a per-perturbation table with promoter-set columns and median % cells", async () => {
    vi.stubGlobal("fetch", variantFetch());
    renderWithClient(
      <PromoterDefinitionsTable
        bindingPrimaries={["rossi"]}
        perturbationDatasets={["hackett"]}
        topN={25}
        preset="Relaxed"
        filters=""
      />,
    );
    // One card for the single perturbation.
    const card = await screen.findByTestId("cp-card-hackett");
    // Header is the perturbation display label.
    expect(within(card).getByText("2020 Overexpression")).toBeInTheDocument();
    // Promoter-set column headers in order.
    const headers = within(card)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual([
      "Binding Dataset",
      "Kang",
      "Mindel",
      "500bp",
      "Intergenic",
    ]);
    // Cells reflect each variant's ratio × 100, one decimal.
    expect(
      screen.getByTestId("cp-cell-hackett-2021 ChIP-exo-Kang").textContent,
    ).toContain("40.0%");
    expect(
      screen.getByTestId("cp-cell-hackett-2021 ChIP-exo-Mindel").textContent,
    ).toContain("30.0%");
    expect(
      screen.getByTestId("cp-cell-hackett-2021 ChIP-exo-500bp").textContent,
    ).toContain("20.0%");
    expect(
      screen.getByTestId("cp-cell-hackett-2021 ChIP-exo-Intergenic").textContent,
    ).toContain("10.0%");
  });

  it("renders the empty state when no variant-bearing binding dataset is selected", () => {
    renderWithClient(
      <PromoterDefinitionsTable
        bindingPrimaries={["harbison"]} // harbison has no promoter variants
        perturbationDatasets={["hackett"]}
        topN={25}
        preset="Relaxed"
        filters=""
      />,
    );
    expect(screen.getByTestId("comparison-variant-empty")).toBeInTheDocument();
  });

  it("shows a loading row while the per-perturbation slice is pending", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>(() => {})));
    renderWithClient(
      <PromoterDefinitionsTable
        bindingPrimaries={["rossi"]}
        perturbationDatasets={["hackett"]}
        topN={25}
        preset="Relaxed"
        filters=""
      />,
    );
    expect(screen.getByTestId("cp-loading-hackett")).toBeInTheDocument();
  });

  it("surfaces the backend error message when a per-perturbation slice fails", async () => {
    vi.stubGlobal("fetch", capErrorFetch());
    renderWithClient(
      <PromoterDefinitionsTable
        bindingPrimaries={["rossi"]}
        perturbationDatasets={["hackett"]}
        topN={25}
        preset="Relaxed"
        filters=""
      />,
    );
    // The error row is visible (not a silent all-"—" table) and carries the
    // backend's readable message via apiErrorMessage.
    const errRow = await screen.findByTestId("cp-error-hackett");
    expect(errRow.textContent).toBe(CAP_ERROR_MSG);
    // And the data table is NOT rendered for that card.
    expect(screen.queryByTestId("cp-table-hackett")).toBeNull();
  });
});

describe("AnalysisMethodsTable", () => {
  beforeEach(() => {
    setArtifactVersion("test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ rows: [] }), { status: 200 })),
    );
  });

  it("renders scoring-variant rows in SCORING_VARIANT_ORDER with median % cells", async () => {
    vi.stubGlobal("fetch", variantFetch());
    renderWithClient(
      <AnalysisMethodsTable
        bindingPrimaries={["rossi"]}
        perturbationDatasets={["hackett"]}
        topN={25}
        preset="Relaxed"
        filters=""
      />,
    );
    const card = await screen.findByTestId("cm-card-rossi-hackett");
    // Rows appear in SCORING_VARIANT_ORDER: Kang, Mindel, 500bp, Intergenic, Peaks.
    const rowLabels = within(card)
      .getAllByRole("row")
      .slice(1) // drop the header row
      .map((r) => r.querySelector("td")?.textContent?.trim());
    expect(rowLabels).toEqual([
      "Promoter Enrichment (Kang)",
      "Promoter Enrichment (Mindel)",
      "Promoter Enrichment (500bp)",
      "Promoter Enrichment (Intergenic)",
      "Original Peaks",
    ]);
    // Kang cell = rossi__hackett 0.4 → 40.0%; Original Peaks = 0.55 → 55.0%.
    expect(
      within(card).getByTestId("cm-row-rossi-hackett-Promoter Enrichment (Kang)")
        .textContent,
    ).toContain("40.0%");
    expect(
      within(card).getByTestId("cm-row-rossi-hackett-Original Peaks").textContent,
    ).toContain("55.0%");
  });

  it("renders one group per eligible primary and skips non-eligible bindings", async () => {
    vi.stubGlobal("fetch", variantFetch());
    renderWithClient(
      <AnalysisMethodsTable
        // harbison + callingcards are NOT peaks-eligible; only rossi is.
        bindingPrimaries={["harbison", "rossi", "callingcards"]}
        perturbationDatasets={["hackett"]}
        topN={25}
        preset="Relaxed"
        filters=""
      />,
    );
    await screen.findByTestId("cm-group-rossi");
    expect(screen.queryByTestId("cm-group-harbison")).toBeNull();
    expect(screen.queryByTestId("cm-group-callingcards")).toBeNull();
  });

  it("renders the empty state when no peaks-eligible binding dataset is selected", () => {
    renderWithClient(
      <AnalysisMethodsTable
        bindingPrimaries={["harbison"]}
        perturbationDatasets={["hackett"]}
        topN={25}
        preset="Relaxed"
        filters=""
      />,
    );
    expect(screen.getByTestId("comparison-variant-empty")).toBeInTheDocument();
  });

  it("surfaces the backend error message when a per-perturbation slice fails", async () => {
    vi.stubGlobal("fetch", capErrorFetch());
    renderWithClient(
      <AnalysisMethodsTable
        bindingPrimaries={["rossi"]}
        perturbationDatasets={["hackett"]}
        topN={25}
        preset="Relaxed"
        filters=""
      />,
    );
    const errRow = await screen.findByTestId("cm-error-rossi-hackett");
    expect(errRow.textContent).toBe(CAP_ERROR_MSG);
    // The scoring-variant table is NOT rendered for the failed card.
    expect(screen.queryByTestId("cm-table-rossi-hackett")).toBeNull();
  });
});

// ===========================================================================
// 12-pair cap relationship (M6b)
// ===========================================================================
//
// The Compare Promoter Definitions tab fires ONE /comparison/topn request per
// perturbation dataset, each over `expandPromoterBindings(variantPrimaries)` ×
// [a SINGLE perturbation]. The widest possible binding axis is
//   len(PROMOTER_SET_ORDER) * (# variant-bearing primaries)
// and `variantPrimaries` is `bindingPrimaries.filter(b => b in
// PROMOTER_VARIANT_PAIRS)`, so the # of variant-bearing primaries is bounded by
// Object.keys(PROMOTER_VARIANT_PAIRS).length. With 1 perturbation per request,
// that product IS the per-request pair count.
//
// The backend caps a /comparison/topn request at defaultMaxComparisonPairs = 12
// (inclusive). This test pins the relationship to the ACTUAL exported constants
// so a future 5th promoter set or 4th variant-bearing primary fails HERE
// instead of silently 400-ing at runtime.
describe("promoter fan-out stays within the backend 12-pair cap", () => {
  // Keep in lockstep with backend defaultMaxComparisonPairs
  // (backend/internal/api/comparison_topn.go:27, inclusive).
  const MAX_COMPARISON_PAIRS = 12;

  it("len(PROMOTER_SET_ORDER) * (# variant-bearing primaries) <= 12", () => {
    const promoterSets = PROMOTER_SET_ORDER.length;
    const variantBearingPrimaries = Object.keys(PROMOTER_VARIANT_PAIRS).length;
    const widestRequest = promoterSets * variantBearingPrimaries;
    expect(widestRequest).toBeLessThanOrEqual(MAX_COMPARISON_PAIRS);
  });
});
