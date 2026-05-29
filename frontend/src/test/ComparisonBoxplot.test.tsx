import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ComparisonBoxplot } from "@/plots/ComparisonBoxplot";
import type { Schemas } from "@/api/client";

// PlotLazy is async (dynamic-imports plotly.js). Replace it with a synchronous
// stub that exposes the data/layout/style it would have rendered, so the tests
// can assert on trace shape and the drift-fix contract without spinning up the
// real Plotly bundle.
type PlotImplProps = {
  data: unknown[];
  layout: Record<string, unknown>;
  style?: Record<string, unknown>;
};
let lastProps: PlotImplProps | null = null;
vi.mock("@/plots/PlotLazy", () => ({
  PlotLazy: (props: PlotImplProps) => {
    lastProps = props;
    return (
      <div data-testid="plot-stub" data-traces={String((props.data ?? []).length)} />
    );
  },
}));

function makeRow(
  pairKey: string,
  ratio: number,
  locus = "YAL001C",
  display: string | null = null,
): Schemas["TopNRow"] {
  return {
    pairKey,
    bindingSampleId: "B",
    regulatorLocusTag: locus,
    regulatorDisplayName: display,
    perturbationSampleId: "P",
    n: 10,
    nResponsive: Math.round(ratio * 10),
    responsiveRatio: ratio,
  };
}

function makeResp(rows: Schemas["TopNRow"][]): Schemas["TopNResponse"] {
  return { topN: 25, effectThreshold: 0, pvalueThreshold: 0.05, rows };
}

describe("ComparisonBoxplot", () => {
  beforeEach(() => {
    lastProps = null;
  });

  it("renders the empty-state when no rows are supplied", () => {
    render(<ComparisonBoxplot resp={makeResp([])} facetBy="binding" />);
    expect(screen.getByText(/No data for the current selection\./)).toBeInTheDocument();
  });

  it("renders one trace per (facet, x_val) combination with data", () => {
    // Two binding sources (facets), two perturbation sources (x), 1 row each —
    // expect 4 traces.
    const rows: Schemas["TopNRow"][] = [
      makeRow("harbison__hackett", 0.5),
      makeRow("harbison__kemmeren", 0.3),
      makeRow("rossi__hackett", 0.7),
      makeRow("rossi__kemmeren", 0.1),
    ];
    render(<ComparisonBoxplot resp={makeResp(rows)} facetBy="binding" />);
    expect(lastProps).not.toBeNull();
    expect(lastProps!.data).toHaveLength(4);
    const facetTitles = (lastProps!.layout.annotations as Array<{ text: string }>).map(
      (a) => a.text,
    );
    // _BINDING_ORDER: "2004 ChIP-chip", "2021 ChIPexo" — both should appear in
    // chronological order regardless of input order.
    expect(facetTitles).toEqual(["2004 ChIP-chip", "2021 ChIPexo"]);
  });

  it("swaps the axis when facetBy=perturbation", () => {
    const rows: Schemas["TopNRow"][] = [
      makeRow("harbison__hackett", 0.5),
      makeRow("rossi__hackett", 0.6),
    ];
    render(<ComparisonBoxplot resp={makeResp(rows)} facetBy="perturbation" />);
    expect(lastProps).not.toBeNull();
    const facetTitles = (lastProps!.layout.annotations as Array<{ text: string }>).map(
      (a) => a.text,
    );
    // Single perturbation source (hackett → "2020 Overexpression") as the
    // sole facet; two binding-source xs (one trace each, both with
    // showlegend=true on the first facet column).
    expect(facetTitles).toEqual(["2020 Overexpression"]);
    expect(lastProps!.data).toHaveLength(2);
  });

  it("uses regulatorDisplayName when present, falling back to regulatorLocusTag", () => {
    const rows: Schemas["TopNRow"][] = [
      makeRow("harbison__hackett", 0.5, "YAL001C", "TFC3"),
      makeRow("harbison__hackett", 0.4, "YAL002C", null),
    ];
    render(<ComparisonBoxplot resp={makeResp(rows)} facetBy="binding" />);
    expect(lastProps).not.toBeNull();
    const traces = lastProps!.data as Array<{ text: string[] }>;
    expect(traces[0]!.text).toEqual(["TFC3", "YAL002C"]);
  });

  // Drift-fix contract (mirrors BindingCorrBoxplot.test.tsx): the chart must not
  // grow/shrink on resize, nor reset zoom/pan/legend when the data changes.
  it("renders with a definite pixel height so it cannot grow/shrink on resize", () => {
    render(<ComparisonBoxplot resp={makeResp([makeRow("harbison__hackett", 0.5)])} facetBy="binding" />);
    const style = lastProps!.style ?? {};
    expect(typeof style.height).toBe("number");
    expect(style.width).toBe("100%");
  });

  it("sets a stable uirevision so zoom/pan/legend survive a data change", () => {
    const { rerender } = render(
      <ComparisonBoxplot resp={makeResp([makeRow("harbison__hackett", 0.5)])} facetBy="binding" />,
    );
    const rev1 = lastProps!.layout.uirevision;
    const data1 = lastProps!.data;
    expect(rev1).toBeDefined();

    // A new top-N / filter result rebuilds traces + the layout literal.
    rerender(
      <ComparisonBoxplot
        resp={makeResp([makeRow("harbison__hackett", 0.9), makeRow("rossi__hackett", 0.1)])}
        facetBy="binding"
      />,
    );
    // uirevision stays constant (preserves zoom/pan/legend) while the trace
    // data genuinely changes — otherwise the assertion would be tautological.
    expect(lastProps!.layout.uirevision).toBe(rev1);
    expect(lastProps!.data).not.toEqual(data1);
  });

  // The boxes (and their width-relative jittered point clouds) were too thin
  // because Plotly's default boxgap/boxgroupgap (0.3 each) squeeze grouped
  // boxes. Tightening both widens each column.
  it("widens the boxes by setting boxgap/boxgroupgap below Plotly's 0.3 defaults", () => {
    render(<ComparisonBoxplot resp={makeResp([makeRow("harbison__hackett", 0.5)])} facetBy="binding" />);
    const layout = lastProps!.layout;
    expect(typeof layout.boxgap).toBe("number");
    expect(typeof layout.boxgroupgap).toBe("number");
    expect(layout.boxgap as number).toBeLessThan(0.3);
    expect(layout.boxgroupgap as number).toBeLessThan(0.3);
  });
});
