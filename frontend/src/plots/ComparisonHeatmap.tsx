import type { Schemas } from "@/api/client";
import { PlotLazy } from "./PlotLazy";

interface ComparisonHeatmapProps {
  resp: Schemas["TopNResponse"];
}

// Renders a regulator x pairKey heatmap of responsive_ratio. Cells with no
// row collapse to `null`, which Plotly renders as transparent.
export function ComparisonHeatmap({ resp }: ComparisonHeatmapProps) {
  const rows = resp.rows ?? [];
  const pairKeys = [...new Set(rows.map((r) => r.pairKey))].sort();
  const regs = [...new Set(rows.map((r) => r.regulatorLocusTag))].sort();
  // Build a O(N) lookup table so the matrix fill is O(R*P) total instead of
  // O(R*P*N) — important when topn returns hundreds of rows.
  const cells = new Map<string, number>();
  for (const r of rows) {
    cells.set(`${r.regulatorLocusTag}|${r.pairKey}`, r.responsiveRatio);
  }
  const z: (number | null)[][] = regs.map((reg) =>
    pairKeys.map((pk) => cells.get(`${reg}|${pk}`) ?? null),
  );

  if (regs.length === 0 || pairKeys.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        No Top-N rows for the current selection. Adjust binding/perturbation datasets or
        thresholds.
      </p>
    );
  }

  return (
    <PlotLazy
      data={
        [
          {
            type: "heatmap",
            z,
            x: pairKeys,
            y: regs,
            colorscale: "Viridis",
            hoverongaps: false,
          },
        ] as never
      }
      layout={{
        height: Math.max(400, regs.length * 18 + 100),
        margin: { l: 100, t: 40 },
        xaxis: { title: { text: "binding__perturbation pair" } },
        yaxis: { title: { text: "regulator" }, automargin: true },
      }}
      config={{ displaylogo: false, responsive: true }}
      useResizeHandler
      style={{ width: "100%", height: "100%" }}
    />
  );
}
