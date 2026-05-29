import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { BindingCorrBoxplot } from "@/plots/BindingCorrBoxplot";
import type { Schemas } from "@/api/client";

// Capture every prop PlotLazy is handed so we can assert the *drift-fix
// contract* (the chart must not grow/shrink on resize, and must not reset
// zoom/pan/legend on data changes) without spinning up the real Plotly bundle.
type Captured = {
  data?: unknown[];
  layout?: Record<string, unknown>;
  style?: Record<string, unknown>;
  config?: Record<string, unknown>;
  useResizeHandler?: boolean;
};
let captured: Captured[] = [];
vi.mock("@/plots/PlotLazy", () => ({
  PlotLazy: (props: Captured) => {
    captured.push(props);
    return <div data-testid="plot-stub" />;
  },
}));

function makeResp(): Schemas["CorrResponse"] {
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
          { dbA: "callingcards", dbAId: "cc_0", dbB: "hackett", dbBId: "h_0", regulatorLocusTag: "YBR289W", correlation: 0.42 },
          { dbA: "callingcards", dbAId: "cc_1", dbB: "hackett", dbBId: "h_1", regulatorLocusTag: "YAL001C", correlation: 0.2 },
        ],
      },
    ],
  } as Schemas["CorrResponse"];
}

const last = () => captured[captured.length - 1]!;

describe("BindingCorrBoxplot drift contract", () => {
  beforeEach(() => {
    captured = [];
  });

  it("renders the data-state plot with a definite pixel height so it cannot grow/shrink on resize", () => {
    render(
      <BindingCorrBoxplot
        resp={makeResp()}
        selectedRegulator="YBR289W"
        onRegulatorClick={() => {}}
      />,
    );
    const style = last().style ?? {};
    // height:"100%" against a content-sized ancestor is the resize ratchet.
    // A definite numeric height pins the container and breaks the loop.
    expect(typeof style.height).toBe("number");
    expect(style.width).toBe("100%");
  });

  it("sets a stable uirevision so zoom/pan/legend survive a data change", () => {
    const { rerender } = render(
      <BindingCorrBoxplot
        resp={makeResp()}
        selectedRegulator="YBR289W"
        onRegulatorClick={() => {}}
      />,
    );
    const rev1 = last().layout?.uirevision;
    const data1 = last().data;
    expect(rev1).toBeDefined();

    // Changing the selected regulator rebuilds traces + the layout literal —
    // exactly the re-render that wiped UI state before the fix.
    rerender(
      <BindingCorrBoxplot
        resp={makeResp()}
        selectedRegulator="YAL001C"
        onRegulatorClick={() => {}}
      />,
    );
    // uirevision stays constant (preserves zoom/pan/legend) ...
    expect(last().layout?.uirevision).toBe(rev1);
    // ... while the data genuinely changes. Without this, the test would still
    // pass if a future memo bug froze trace updates (making it tautological).
    expect(captured).toHaveLength(2);
    expect(last().data).not.toEqual(data1);
  });

  it("renders the empty state with a definite pixel height too", () => {
    render(
      <BindingCorrBoxplot
        resp={{ method: "pearson", col: "effect", regulatorDisplay: {}, pairs: [] } as Schemas["CorrResponse"]}
        selectedRegulator={null}
        onRegulatorClick={() => {}}
      />,
    );
    expect(typeof (last().style ?? {}).height).toBe("number");
  });
});
