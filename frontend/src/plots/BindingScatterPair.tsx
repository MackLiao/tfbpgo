import type { Schemas } from "@/api/client";
import { PlotLazy } from "./PlotLazy";

// Per-pair scatter for the Binding module.
//
// Mirrors reference/tfbpshiny/modules/binding/server/workspace.py:493-610
// (the inner `_make_scatter_render` figure). One Plotly scatter per active
// (dbA, dbB) pair, fixed 400x400, intended to be laid out in a flex row by
// BindingScatterRow. When the regulator yielded zero rows the slot collapses
// to a zero-width span (Shiny ui.span()).

export interface BindingScatterPairProps {
  resp: Schemas["ScatterResponse"];
  displayNameA: string;
  displayNameB: string;
}

export function BindingScatterPair({
  resp,
  displayNameA,
  displayNameB,
}: BindingScatterPairProps) {
  // Collapse empty pairs — Shiny renders an empty span; the BindingScatterRow
  // surfaces "regulator not found" notices separately, so silence here is fine.
  if (!resp.points || resp.points.length === 0) {
    return <span />;
  }

  const xs = resp.points.map((p) => p.valA);
  const ys = resp.points.map((p) => p.valB);
  const texts = resp.points.map((p) => p.targetLocusTag);

  const hoverTemplate =
    `${displayNameA}: %{x:.3f}<br>${displayNameB}: %{y:.3f}<extra></extra>`;

  const trace = {
    type: "scatter",
    mode: "markers",
    x: xs,
    y: ys,
    text: texts,
    marker: { size: 4, opacity: 0.6, color: "#4A90D9" },
    hovertemplate: hoverTemplate,
    showlegend: false,
  };

  return (
    <div style={{ flex: "0 0 auto" }}>
      <PlotLazy
        data={[trace] as never}
        layout={{
          width: 400,
          height: 400,
          margin: { l: 50, r: 20, t: 100, b: 50 },
          title: {
            text: `${displayNameA}<br>vs<br>${displayNameB}`,
            xanchor: "center",
            x: 0.5,
          },
          xaxis: { title: { text: `${displayNameA}: ${resp.colA}` } },
          yaxis: { title: { text: `${displayNameB}: ${resp.colB}` } },
          showlegend: false,
          annotations: [
            {
              text: `r=${resp.r.toFixed(3)}`,
              xref: "paper",
              yref: "paper",
              x: 0.98,
              y: 0.98,
              xanchor: "right",
              yanchor: "top",
              showarrow: false,
              font: { size: 12 },
            },
          ],
        }}
        config={{ displaylogo: false, responsive: false }}
        style={{ width: 400, height: 400 }}
      />
    </div>
  );
}
