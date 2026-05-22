import { useMemo } from "react";
import type { Schemas } from "@/api/client";
import { PlotLazy } from "./PlotLazy";
import {
  BINDING_ORDER,
  BINDING_PALETTE,
  PERTURBATION_ORDER,
  PERTURBATION_PALETTE,
  FALLBACK_COLOR,
  bindingLabel,
  perturbationLabel,
} from "@/lib/comparison-palette";

export interface ComparisonBoxplotProps {
  resp: Schemas["TopNResponse"];
  facetBy: "binding" | "perturbation";
}

interface Point {
  y: number;
  text: string;
}

// Faceted boxplot mirroring reference/tfbpshiny/modules/comparison/server/
// workspace.py:221-323. One subplot per facet value (binding or perturbation
// source, chosen by `facetBy`); within each subplot, one Box trace per x-axis
// value containing every responsiveRatio*100 for the (facet, x) pair. Points
// are jittered overlays; the box itself is not hover-active.
//
// Trace coalescing happens by (facet, x_val), so the regulator-level cell-key
// collision that ComparisonHeatmap suffered (multiple rows for the same
// regulator+pair collapsing to a single z value) cannot happen here — every
// row contributes its own point.
export function ComparisonBoxplot({ resp, facetBy }: ComparisonBoxplotProps) {
  const { traces, facetTitles, legendTitle, hasData } = useMemo(
    () => buildTraces(resp.rows ?? [], facetBy),
    [resp.rows, facetBy],
  );

  if (!hasData) {
    return (
      <p className="text-sm text-slate-600">No data for the current selection.</p>
    );
  }

  // Layout: divide the [0, 1] domain into N equal columns, one per facet,
  // sharing the y-axis (`matches: "y"`). Each subplot gets its own xaxis
  // (xaxis, xaxis2, ...) plus an annotation that serves as the subplot title.
  const nFacets = facetTitles.length;
  const gap = 0.02;
  const colWidth = (1 - gap * (nFacets - 1)) / nFacets;

  // Build per-axis layout entries plus subplot-title annotations.
  const layout: Record<string, unknown> = {
    height: 460,
    margin: { l: 50, r: 20, t: 80, b: 30 },
    boxmode: "group",
    showlegend: true,
    legend: { title: { text: legendTitle } },
    annotations: facetTitles.map((title, i) => {
      const x0 = (colWidth + gap) * i;
      const x1 = x0 + colWidth;
      return {
        text: title,
        x: (x0 + x1) / 2,
        y: 1.02,
        xref: "paper",
        yref: "paper",
        xanchor: "center",
        yanchor: "bottom",
        showarrow: false,
        font: { size: 13 },
      };
    }),
    yaxis: {
      title: { text: "% responsive in top N" },
      range: [0, 100],
      automargin: true,
    },
  };

  for (let i = 0; i < nFacets; i++) {
    const x0 = (colWidth + gap) * i;
    const x1 = x0 + colWidth;
    const key = i === 0 ? "xaxis" : `xaxis${i + 1}`;
    // All subplots anchor to a single shared y-axis (Plotly's shared-y
    // layout — equivalent to subplots.make_subplots(shared_yaxes=True)).
    // Horizontal partitioning happens via the `domain` field above.
    layout[key] = {
      domain: [x0, x1],
      showticklabels: false,
      anchor: "y",
    };
  }

  return (
    <PlotLazy
      data={traces as never}
      layout={layout}
      config={{ displaylogo: false, responsive: true }}
      useResizeHandler
      style={{ width: "100%", height: "100%" }}
    />
  );
}

interface BuildResult {
  traces: Array<Record<string, unknown>>;
  facetTitles: string[];
  legendTitle: string;
  hasData: boolean;
}

function buildTraces(
  rows: ReadonlyArray<Schemas["TopNRow"]>,
  facetBy: "binding" | "perturbation",
): BuildResult {
  // Split pairKey ("{bindingDB}__{perturbationDB}") into the two db_names,
  // translate each to its display label via the static label maps, then
  // group rows by (facet, x_val).
  type Cell = { facet: string; x: string; pt: Point };
  const cells: Cell[] = [];
  for (const row of rows) {
    const sep = row.pairKey.indexOf("__");
    if (sep < 0) continue;
    const bindingDB = row.pairKey.slice(0, sep);
    const perturbationDB = row.pairKey.slice(sep + 2);
    const bLabel = bindingLabel(bindingDB);
    const pLabel = perturbationLabel(perturbationDB);
    const facet = facetBy === "binding" ? bLabel : pLabel;
    const x = facetBy === "binding" ? pLabel : bLabel;
    const text = row.regulatorDisplayName ?? row.regulatorLocusTag;
    cells.push({ facet, x, pt: { y: row.responsiveRatio * 100, text } });
  }

  if (cells.length === 0) {
    return { traces: [], facetTitles: [], legendTitle: "", hasData: false };
  }

  // Apply chronological ordering, filtered to the facet/x values that
  // actually have data — mirrors workspace.py:263-264.
  const facetOrder = facetBy === "binding" ? BINDING_ORDER : PERTURBATION_ORDER;
  const xOrder = facetBy === "binding" ? PERTURBATION_ORDER : BINDING_ORDER;
  const palette = facetBy === "binding" ? PERTURBATION_PALETTE : BINDING_PALETTE;
  const legendTitle =
    facetBy === "binding" ? "Perturbation source" : "Binding source";

  const presentFacets = new Set(cells.map((c) => c.facet));
  const presentXs = new Set(cells.map((c) => c.x));
  const facets = facetOrder.filter((f) => presentFacets.has(f));
  const xs = xOrder.filter((x) => presentXs.has(x));

  // Surface non-canonical labels (db_names with no entry in the static map)
  // as additional facets/xs appended after the chronological set, so the plot
  // still renders something rather than dropping them silently.
  for (const f of presentFacets) if (!facets.includes(f)) facets.push(f);
  for (const x of presentXs) if (!xs.includes(x)) xs.push(x);

  if (facets.length === 0 || xs.length === 0) {
    return { traces: [], facetTitles: [], legendTitle, hasData: false };
  }

  const grouped = new Map<string, Point[]>();
  for (const c of cells) {
    const k = `${c.facet}\x1f${c.x}`;
    let arr = grouped.get(k);
    if (!arr) {
      arr = [];
      grouped.set(k, arr);
    }
    arr.push(c.pt);
  }

  const traces: Array<Record<string, unknown>> = [];
  facets.forEach((facetVal, colIdx) => {
    for (const xVal of xs) {
      const points = grouped.get(`${facetVal}\x1f${xVal}`) ?? [];
      if (points.length === 0) continue;
      const color = palette[xVal] ?? FALLBACK_COLOR;
      traces.push({
        type: "box",
        y: points.map((p) => p.y),
        text: points.map((p) => p.text),
        name: xVal,
        marker: { color, size: 4, opacity: 0.5 },
        line: { width: 1.2 },
        boxpoints: "all",
        jitter: 0.4,
        pointpos: 0,
        legendgroup: xVal,
        showlegend: colIdx === 0,
        hoveron: "points",
        hovertemplate: "%{text}<br>%{y:.1f}%<extra></extra>",
        // Assign trace to subplot `xaxis{colIdx+1}` (Plotly convention: blank
        // suffix for the first one).
        xaxis: colIdx === 0 ? "x" : `x${colIdx + 1}`,
        yaxis: "y",
      });
    }
  });

  return {
    traces,
    facetTitles: facets,
    legendTitle,
    hasData: traces.length > 0,
  };
}
