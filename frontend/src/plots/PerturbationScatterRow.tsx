// Mirrors plots/BindingScatterRow.tsx 1:1 with /perturbation/scatter.
// Keep these in sync.
import { useQueries } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { PerturbationScatterPair } from "./PerturbationScatterPair";
import { PlotSkeleton } from "@/components/PlotSkeleton";

// Per-pair scatter row for the Perturbation module.
//
// Mirrors reference/tfbpshiny/modules/perturbation/server/workspace.py:402-427,
// 471-581: one scatter per sorted(datasets) choose 2 pair. We fan out
// independent TanStack Query calls so each pair resolves on its own — same
// effect as Shiny's per-pair @render.ui slots.

export interface PerturbationScatterRowProps {
  regulator: string;
  datasets: string[];
  method: "pearson" | "spearman";
  col: "effect" | "pvalue";
  filters: string;
  datasetDisplay: (dbName: string) => string;
}

// itertools.combinations(sorted(datasets), 2) — keep ordering stable so cache
// keys are deterministic across param-order permutations.
export function sortedCombinations(datasets: string[]): Array<[string, string]> {
  const sorted = [...datasets].sort();
  const out: Array<[string, string]> = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i] as string;
      const b = sorted[j] as string;
      out.push([a, b]);
    }
  }
  return out;
}

export function PerturbationScatterRow({
  regulator,
  datasets,
  method,
  col,
  filters,
  datasetDisplay,
}: PerturbationScatterRowProps) {
  const pairs = sortedCombinations(datasets);

  const queries = useQueries({
    queries: pairs.map(([dbA, dbB]) => ({
      queryKey: qk.perturbationScatter(regulator, [dbA, dbB], method, col, filters),
      queryFn: ({ signal }) => {
        const base = {
          regulator,
          pair: [dbA, dbB] as [string, string],
          method,
          col,
        };
        return api.perturbationScatter(filters ? { ...base, filters } : base, signal);
      },
      enabled: Boolean(regulator) && datasets.length >= 2,
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
          <PerturbationScatterPair
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
