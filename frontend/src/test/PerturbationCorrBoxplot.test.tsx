import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { PerturbationCorrBoxplot } from "@/plots/PerturbationCorrBoxplot";
import type { Schemas } from "@/api/client";

// See BindingCorrBoxplot.test.tsx — same drift-fix contract, mirrored module.
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
        dbA: "kemmeren",
        dbB: "hackett",
        colA: "effect",
        colB: "effect",
        points: [
          { dbA: "kemmeren", dbAId: "k_0", dbB: "hackett", dbBId: "h_0", regulatorLocusTag: "YBR289W", correlation: 0.42 },
          { dbA: "kemmeren", dbAId: "k_1", dbB: "hackett", dbBId: "h_1", regulatorLocusTag: "YAL001C", correlation: 0.2 },
        ],
      },
    ],
  } as Schemas["CorrResponse"];
}

const last = () => captured[captured.length - 1]!;

describe("PerturbationCorrBoxplot drift contract", () => {
  beforeEach(() => {
    captured = [];
  });

  it("renders the data-state plot with a definite pixel height so it cannot grow/shrink on resize", () => {
    render(
      <PerturbationCorrBoxplot
        resp={makeResp()}
        selectedRegulator="YBR289W"
        onRegulatorClick={() => {}}
      />,
    );
    const style = last().style ?? {};
    expect(typeof style.height).toBe("number");
    expect(style.width).toBe("100%");
  });

  it("sets a stable uirevision so zoom/pan/legend survive a data change", () => {
    const { rerender } = render(
      <PerturbationCorrBoxplot
        resp={makeResp()}
        selectedRegulator="YBR289W"
        onRegulatorClick={() => {}}
      />,
    );
    const rev1 = last().layout?.uirevision;
    const data1 = last().data;
    expect(rev1).toBeDefined();

    rerender(
      <PerturbationCorrBoxplot
        resp={makeResp()}
        selectedRegulator="YAL001C"
        onRegulatorClick={() => {}}
      />,
    );
    // uirevision stays constant (preserves zoom/pan/legend) ...
    expect(last().layout?.uirevision).toBe(rev1);
    // ... while the data genuinely changes (guards against a future memo bug
    // freezing trace updates and making this test tautological).
    expect(captured).toHaveLength(2);
    expect(last().data).not.toEqual(data1);
  });

  it("renders the empty state with a definite pixel height too", () => {
    render(
      <PerturbationCorrBoxplot
        resp={{ method: "pearson", col: "effect", regulatorDisplay: {}, pairs: [] } as Schemas["CorrResponse"]}
        selectedRegulator={null}
        onRegulatorClick={() => {}}
      />,
    );
    expect(typeof (last().style ?? {}).height).toBe("number");
  });
});
