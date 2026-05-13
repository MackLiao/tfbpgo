import type { Schemas } from "@/api/client";
import { PlotLazy } from "./PlotLazy";

interface PerturbationVolcanoProps {
  datasets: Schemas["PerturbationDatasetResult"][];
}

export function PerturbationVolcano({ datasets }: PerturbationVolcanoProps) {
  const traces = datasets.map((d) => ({
    type: "scattergl",
    mode: "markers",
    name: d.dbName,
    x: d.rows.map((r) => r.value),
    // Placeholder until backend exposes pvalue separately; plot |effect| as y.
    y: d.rows.map((r) => Math.abs(r.value)),
    hovertext: d.rows.map((r) => r.targetLocusTag),
  }));
  return (
    <PlotLazy
      data={traces as never}
      layout={{
        height: 400,
        margin: { t: 20 },
        xaxis: { title: { text: "effect" } },
        yaxis: { title: { text: "|effect|" } },
      }}
      config={{ displaylogo: false, responsive: true }}
      useResizeHandler
      style={{ width: "100%", height: "100%" }}
    />
  );
}
