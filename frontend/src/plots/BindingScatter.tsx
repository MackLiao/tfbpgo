import type { Schemas } from "@/api/client";
import { PlotLazy } from "./PlotLazy";

interface BindingScatterProps {
  datasets: Schemas["BindingDatasetResult"][];
}

export function BindingScatter({ datasets }: BindingScatterProps) {
  const total = datasets.reduce((n, d) => n + d.rows.length, 0);
  const useGL = total > 5000;
  const traces = datasets.map((d) => ({
    type: useGL ? "scattergl" : "scatter",
    mode: "markers",
    name: d.dbName,
    x: d.rows.map((r) => r.targetLocusTag),
    y: d.rows.map((r) => r.value),
    hovertext: d.rows.map((r) => r.sampleId),
  }));
  return (
    <PlotLazy
      data={traces as never}
      layout={{ height: 400, margin: { t: 20 }, xaxis: { showticklabels: false } }}
      config={{ displaylogo: false, responsive: true }}
      useResizeHandler
      style={{ width: "100%", height: "100%" }}
    />
  );
}
