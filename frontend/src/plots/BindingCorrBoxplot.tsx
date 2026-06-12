import { useMemo } from "react";
import type { Schemas } from "@/api/client";
import { htmlEscape } from "@/lib/html-escape";
import { pairKey } from "./CorrelationMatrix";
import { PlotLazy } from "./PlotLazy";

// Pairwise correlation distribution box plot for the Binding module.
//
// Mirrors reference/tfbpshiny/modules/binding/server/workspace.py
// (pair_box_container + _make_pair_box_render): one go.Box per COMMITTED
// dataset pair (workspace.py:678 `pairs = committed_pairs()`), not every active
// pair. The committed selection is supplied by the parent route as a set of
// canonical `dbA__dbB` keys; pairs outside it are filtered out here.
//   - One go.Box per committed pair, points jittered (jitter=0.4,
//     pointpos=0, boxpoints="all"). Each point's customdata is the regulator
//     locus tag — clicking a point lifts the locus tag up to the parent
//     route so the URL ?regulator= can be updated (Shiny achieves the same
//     via a Plotly post_script that calls Shiny.setInputValue).
//   - Second go.Scatter overlay trace highlights the currently-selected
//     regulator (large black dot, one per pair where the regulator has a
//     correlation row).
//   - Empty state (zero committed pairs) is a centered annotation hinting the
//     user to select cells in the Correlation Matrix and run Execute Analysis
//     (workspace.py:647-655 pair_box_status).

export interface BindingCorrBoxplotProps {
  resp: Schemas["CorrResponse"];
  selectedRegulator: string | null;
  // Optional db_name → display_name map. Falls back to db_name when absent.
  datasetDisplay?: (dbName: string) => string;
  // Optional locus_tag → display_name map for regulator hover text.
  regulatorDisplayMap?: Record<string, string>;
  // Optional per-dataset sample_id → condition-label map. When present,
  // selected-regulator overlay hovertext appends one line per dataset
  // ("<dataset display>: <condition label>"). Mirrors Shiny's
  // workspace.py:295-306 (`fetch_sample_condition_map` → hover join).
  sampleConditionsByDB?: Record<string, Record<string, string>>;
  onRegulatorClick: (locusTag: string) => void;
  // Committed pair selection as canonical `dbA__dbB` keys. Only pairs whose
  // key is in this set are rendered (workspace.py:678 committed_pairs gating).
  // When omitted, all pairs render (back-compat for any non-gated caller).
  committedPairKeys?: Set<string>;
}

interface PointAccumulator {
  ys: number[];
  texts: string[];
  customdata: string[];
}

interface OverlayPoint {
  x: string;
  y: number;
  // Symbol or fallback locus tag for the selected regulator (pre-escape).
  symbol: string;
  // Per-side dataset + sample-id context, used to look up condition
  // labels at render time (mirrors workspace.py:295-306).
  dbA: string;
  dbAId: string;
  dbB: string;
  dbBId: string;
}

export function BindingCorrBoxplot({
  resp,
  selectedRegulator,
  datasetDisplay,
  regulatorDisplayMap,
  sampleConditionsByDB,
  onRegulatorClick,
  committedPairKeys,
}: BindingCorrBoxplotProps) {
  const displayDb = datasetDisplay ?? ((db: string) => db);
  const regDisplay = (locus: string): string =>
    regulatorDisplayMap?.[locus] ?? locus;

  const methodLabel = resp.method === "spearman" ? "Spearman" : "Pearson";
  const title = `${methodLabel} correlation across regulators`;
  const yAxisTitle = `${methodLabel} r`;

  const { boxTraces, overlayTrace, hasPairs } = useMemo(() => {
    // Render only committed pairs. workspace.py:678-689 iterates
    // committed_pairs() (intersected with the active pair set) — an undefined
    // set means "no gating" for back-compat, but the Binding route always
    // supplies one.
    const pairs = (resp.pairs ?? []).filter((p) =>
      committedPairKeys ? committedPairKeys.has(pairKey(p.dbA, p.dbB)) : true,
    );
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
      // Per-point hovertext, mirroring workspace.py:295-306:
      //   "<symbol>\nr = X.XXX\n<dataset A>: <cond A>\n<dataset B>: <cond B>"
      // joined with "<br>". Every DB-sourced string (symbol, display
      // name, condition label) is HTML-escaped before injection because
      // Plotly renders hovertext as HTML by default.
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
    committedPairKeys,
  ]);

  // Empty state: render a placeholder annotation centered in the figure,
  // matching workspace.py:236-245.
  if (!hasPairs) {
    return (
      <PlotLazy
        data={[] as never}
        layout={{
          height: 360,
          // Stable uirevision: preserve zoom/pan/legend across data-driven
          // re-renders (see PlotLazy block comment below). Constant per page.
          uirevision: "binding-corr",
          margin: { l: 40, r: 20, t: 50, b: 80 },
          xaxis: { visible: false },
          yaxis: { visible: false },
          showlegend: false,
          annotations: [
            {
              text:
                "Select cells in the Correlation Matrix and click Execute " +
                "Analysis to view their distributions.",
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
        // Definite pixel height (matches layout.height). A "100%" height
        // against a content-sized ancestor lets Plotly's resize read offset-
        // Height, grow the container, re-read, and ratchet bigger on every
        // window/panel resize — pinning the height breaks that loop.
        style={{ width: "100%", height: 360 }}
      />
    );
  }

  const data = overlayTrace ? [...boxTraces, overlayTrace] : boxTraces;

  return (
    <PlotLazy
      data={data as never}
      layout={{
        height: 420,
        // Constant uirevision keeps the user's zoom/pan and the selected-
        // regulator overlay framing stable when traces rebuild (new regulator,
        // refetched pairs, late-arriving sample-condition hover data).
        uirevision: "binding-corr",
        title: { text: title },
        margin: { l: 40, r: 20, t: 50, b: 80 },
        showlegend: false,
        yaxis: { title: { text: yAxisTitle } },
      }}
      config={{ displaylogo: false, responsive: true }}
      useResizeHandler
      // Definite pixel height (matches layout.height) — see empty-state note:
      // prevents the resize ratchet from height:"100%".
      style={{ width: "100%", height: 420 }}
      onClick={(evt: { points?: Array<{ customdata?: unknown }> }) => {
        const pt = evt?.points?.[0];
        if (pt && pt.customdata != null) {
          onRegulatorClick(String(pt.customdata));
        }
      }}
    />
  );
}
