import { useQueries } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { CorrMethod, MeasurementCol } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { BindingScatterPair } from "./BindingScatterPair";
import { PlotSkeleton } from "@/components/PlotSkeleton";

// Per-pair scatter row for the Binding module.
//
// Mirrors reference/tfbpshiny/modules/binding/server/workspace.py
// (scatter_container + _make_scatter_render): one scatter per COMMITTED pair.
// In the reference the scatter is gated on committed_pairs() (workspace.py:992
// `sel = committed_pairs()`) — with nothing committed the grid stays empty
// rather than defaulting to every active pair. We pass the committed pairs in
// directly and fan out independent TanStack Query calls so each pair resolves
// on its own — same effect as Shiny's per-pair @render.ui slots.

export interface BindingScatterRowProps {
  regulator: string;
  // Committed dataset pairs, each as a canonical [dbA, dbB] tuple (sorted).
  // Replaces the old "all sorted(datasets) choose 2" expansion: only pairs the
  // user committed via Execute Analysis are plotted.
  pairs: Array<[string, string]>;
  method: CorrMethod;
  col: MeasurementCol;
  filters: string;
  datasetDisplay: (dbName: string) => string;
}

export function BindingScatterRow({
  regulator,
  pairs,
  method,
  col,
  filters,
  datasetDisplay,
}: BindingScatterRowProps) {
  const queries = useQueries({
    queries: pairs.map(([dbA, dbB]) => ({
      queryKey: qk.bindingScatter(regulator, [dbA, dbB], method, col, filters),
      queryFn: ({ signal }) => {
        const base = {
          regulator,
          pair: [dbA, dbB] as [string, string],
          method,
          col,
        };
        return api.bindingScatter(filters ? { ...base, filters } : base, signal);
      },
      enabled: Boolean(regulator) && pairs.length > 0,
    })),
  });

  return (
    <div className="flex flex-wrap gap-4">
      {pairs.map(([dbA, dbB], i) => {
        const q = queries[i];
        const key = `${dbA}__${dbB}`;
        if (!q) return null;
        if (q.error) {
          return (
            <div
              key={key}
              className="flex-none rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700"
              style={{ width: 400, height: 400 }}
            >
              {(q.error as Error).message}
            </div>
          );
        }
        if (q.isPending) {
          return (
            <div key={key} style={{ flex: "0 0 auto", width: 400, height: 400 }}>
              <PlotSkeleton />
            </div>
          );
        }
        if (!q.data) return null;
        return (
          <BindingScatterPair
            key={key}
            resp={q.data}
            displayNameA={datasetDisplay(dbA)}
            displayNameB={datasetDisplay(dbB)}
          />
        );
      })}
    </div>
  );
}
