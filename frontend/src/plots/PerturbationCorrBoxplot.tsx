// Mirrors plots/BindingCorrBoxplot.tsx 1:1 with /perturbation/correlations.
// Keep these in sync.
import { useMemo } from "react";
import type { Schemas } from "@/api/client";
import { htmlEscape } from "@/lib/html-escape";
import { PlotLazy } from "./PlotLazy";

// Pairwise correlation distribution box plot for the Perturbation module.
//
// Mirrors reference/tfbpshiny/modules/perturbation/server/workspace.py:199-345:
//   - One go.Box per active dataset pair, points jittered (jitter=0.4,
//     pointpos=0, boxpoints="all"). Each point's customdata is the regulator
//     locus tag — clicking a point lifts the locus tag up to the parent
//     route so the URL ?regulator= can be updated (Shiny achieves the same
//     via a Plotly post_script that calls Shiny.setInputValue).
//   - Second go.Scatter overlay trace highlights the currently-selected
//     regulator (large black dot, one per pair where the regulator has a
//     correlation row).
//   - Empty state (zero pairs) is a centered annotation matching the
//     Shiny placeholder string.

export interface PerturbationCorrBoxplotProps {
  resp: Schemas["CorrResponse"];
  selectedRegulator: string | null;
  // Optional db_name → display_name map. Falls back to db_name when absent.
  datasetDisplay?: (dbName: string) => string;
  // Optional locus_tag → display_name map for regulator hover text.
  regulatorDisplayMap?: Record<string, string>;
  // Optional per-dataset sample_id → condition-label map. Mirrors
  // BindingCorrBoxplot — see that file's comment for the hover format.
  sampleConditionsByDB?: Record<string, Record<string, string>>;
  onRegulatorClick: (locusTag: string) => void;
}

interface PointAccumulator {
  ys: number[];
  texts: string[];
  customdata: string[];
}

interface OverlayPoint {
  x: string;
  y: number;
  symbol: string;
  dbA: string;
  dbAId: string;
  dbB: string;
  dbBId: string;
}

export function PerturbationCorrBoxplot({
  resp,
  selectedRegulator,
  datasetDisplay,
  regulatorDisplayMap,
  sampleConditionsByDB,
  onRegulatorClick,
}: PerturbationCorrBoxplotProps) {
  const displayDb = datasetDisplay ?? ((db: string) => db);
  const regDisplay = (locus: string): string =>
    regulatorDisplayMap?.[locus] ?? locus;

  const methodLabel = resp.method === "spearman" ? "Spearman" : "Pearson";
  const title = `${methodLabel} correlation across regulators`;
  const yAxisTitle = `${methodLabel} r`;

  const { boxTraces, overlayTrace, hasPairs } = useMemo(() => {
    const pairs = resp.pairs ?? [];
    if (pairs.length === 0) {
      return {
        boxTraces: [] as Array<Record<string, unknown>>,
        overlayTrace: null as Record<string, unknown> | null,
        hasPairs: false,
      };
    }

    const traces: Array<Record<string, unknown>> = [];
    const overlay: OverlayPoint[] = [];

    for (const pair of pairs) {
      const xLabel = `${displayDb(pair.dbA)}<br>vs<br>${displayDb(pair.dbB)}`;
      const acc: PointAccumulator = { ys: [], texts: [], customdata: [] };

      for (const pt of pair.points) {
        acc.ys.push(pt.correlation);
        acc.texts.push(regDisplay(pt.regulatorLocusTag));
        acc.customdata.push(pt.regulatorLocusTag);

        if (selectedRegulator && pt.regulatorLocusTag === selectedRegulator) {
          overlay.push({
            x: xLabel,
            y: pt.correlation,
            symbol: regDisplay(pt.regulatorLocusTag),
            dbA: pair.dbA,
            dbAId: pt.dbAId,
            dbB: pair.dbB,
            dbBId: pt.dbBId,
          });
        }
      }

      // One box per pair. Use a constant x value per box so jitter spreads
      // points horizontally within the same categorical slot.
      traces.push({
        type: "box",
        name: xLabel,
        x: acc.ys.map(() => xLabel),
        y: acc.ys,
        text: acc.texts,
        customdata: acc.customdata,
        boxpoints: "all",
        jitter: 0.4,
        pointpos: 0,
        marker: { size: 4, opacity: 0.5 },
        line: { width: 1.5 },
        hoveron: "points",
        hovertemplate: "%{text}<br>r = %{y:.3f}<extra></extra>",
        showlegend: false,
      });
    }

    let overlayTrace: Record<string, unknown> | null = null;
    if (overlay.length > 0) {
      // Per-point hovertext, mirroring workspace.py:295-306 (binding) /
      // the equivalent perturbation overlay: a multi-line string with
      // symbol, r, and per-side condition labels. HTML-escaped because
      // Plotly renders hovertext as HTML.
      const hovertext = overlay.map((p) => {
        const lines: string[] = [];
        lines.push(htmlEscape(p.symbol));
        lines.push(`r = ${p.y.toFixed(3)}`);
        const condA = sampleConditionsByDB?.[p.dbA]?.[p.dbAId] ?? "";
        const condB = sampleConditionsByDB?.[p.dbB]?.[p.dbBId] ?? "";
        if (condA) {
          lines.push(`${htmlEscape(displayDb(p.dbA))}: ${htmlEscape(condA)}`);
        }
        if (condB) {
          lines.push(`${htmlEscape(displayDb(p.dbB))}: ${htmlEscape(condB)}`);
        }
        return lines.join("<br>");
      });
      overlayTrace = {
        type: "scatter",
        mode: "markers",
        x: overlay.map((p) => p.x),
        y: overlay.map((p) => p.y),
        hovertext,
        marker: { size: 10, color: "black", symbol: "circle" },
        hovertemplate: "%{hovertext}<extra></extra>",
        showlegend: false,
      };
    }

    return { boxTraces: traces, overlayTrace, hasPairs: true };
  }, [
    resp.pairs,
    selectedRegulator,
    displayDb,
    regulatorDisplayMap,
    sampleConditionsByDB,
  ]);

  // Empty state: render a placeholder annotation centered in the figure,
  // matching workspace.py:217-226.
  if (!hasPairs) {
    return (
      <PlotLazy
        data={[] as never}
        layout={{
          height: 360,
          margin: { l: 40, r: 20, t: 50, b: 80 },
          xaxis: { visible: false },
          yaxis: { visible: false },
          showlegend: false,
          annotations: [
            {
              text: "Select at least two perturbation datasets to see correlations.",
              xref: "paper",
              yref: "paper",
              x: 0.5,
              y: 0.5,
              xanchor: "center",
              yanchor: "middle",
              showarrow: false,
              font: { size: 14, color: "#475569" },
            },
          ],
        }}
        config={{ displaylogo: false, responsive: true }}
        useResizeHandler
        style={{ width: "100%", height: "100%" }}
      />
    );
  }

  const data = overlayTrace ? [...boxTraces, overlayTrace] : boxTraces;

  return (
    <PlotLazy
      data={data as never}
      layout={{
        height: 420,
        title: { text: title },
        margin: { l: 40, r: 20, t: 50, b: 80 },
        showlegend: false,
        yaxis: { title: { text: yAxisTitle } },
      }}
      config={{ displaylogo: false, responsive: true }}
      useResizeHandler
      style={{ width: "100%", height: "100%" }}
      onClick={(evt: { points?: Array<{ customdata?: unknown }> }) => {
        const pt = evt?.points?.[0];
        if (pt && pt.customdata != null) {
          onRegulatorClick(String(pt.customdata));
        }
      }}
    />
  );
}
