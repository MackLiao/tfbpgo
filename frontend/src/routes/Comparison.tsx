import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, apiErrorMessage } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { ComparisonBoxplot } from "@/plots/ComparisonBoxplot";
import { ComparisonBoxplotSkeleton } from "@/plots/ComparisonBoxplotSkeleton";
import {
  ComparisonSidebar,
  type ComparisonSidebarChange,
} from "@/components/ComparisonSidebar";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Comparison route — faceted boxplot replacement for the old heatmap.
//
// Parity reference: reference/tfbpshiny/modules/comparison/{ui.py,
// server/workspace.py, server/sidebar.py}.
//
// URL is the canonical state: all four sidebar params (`top_n`, `effect`,
// `pvalue`, `facet_by`) are deep-linkable and writeable. The DTO tab from
// the previous iteration is removed — Shiny has no equivalent, see
// docs/parity/comparison.md §2 row 18. (`api.dto` remains in client.ts for
// potential future use but is unused on the frontend.)

const DEFAULTS = {
  topN: 25,
  effect: 0,
  pvalue: 0.05,
  facetBy: "binding" as const,
};

function parseFacetBy(raw: string | null): "binding" | "perturbation" {
  return raw === "perturbation" ? "perturbation" : "binding";
}

export function Comparison() {
  const [params, setParams] = useSearchParams();
  const binding = (params.get("binding") ?? "").split(",").filter(Boolean);
  const perturbation = (params.get("perturbation") ?? "")
    .split(",")
    .filter(Boolean);
  const topN = clampNumber(params.get("top_n"), DEFAULTS.topN, 1, 500);
  const effect = clampNumber(params.get("effect"), DEFAULTS.effect, 0, 5);
  const pvalue = clampNumber(params.get("pvalue"), DEFAULTS.pvalue, 0.001, 1);
  const facetBy = parseFacetBy(params.get("facet_by"));
  const filters = params.get("filters") ?? "";

  const topnQuery = useQuery({
    queryKey: qk.topn(binding, perturbation, topN, effect, pvalue, filters),
    queryFn: ({ signal }) => {
      const base = { binding, perturbation, top_n: topN, effect, pvalue };
      return api.topn(filters ? { ...base, filters } : base, signal);
    },
    enabled: binding.length > 0 && perturbation.length > 0,
  });

  const handleSidebarChange = (next: ComparisonSidebarChange): void => {
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      if (next.topN !== undefined) out.set("top_n", String(next.topN));
      if (next.effect !== undefined) out.set("effect", String(next.effect));
      if (next.pvalue !== undefined) out.set("pvalue", String(next.pvalue));
      if (next.facetBy !== undefined) out.set("facet_by", next.facetBy);
      return out;
    });
  };

  return (
    <section className="grid grid-cols-[260px_1fr] gap-4">
      <ComparisonSidebar
        topN={topN}
        effect={effect}
        pvalue={pvalue}
        facetBy={facetBy}
        onChange={handleSidebarChange}
      />
      <div className="space-y-4">
        {/* C-8: page heading, matching Binding/Perturbation (comparison/ui.py:19). */}
        <h1 className="text-2xl font-semibold">
          Binding vs. Perturbation Comparison
        </h1>
        <ErrorBoundary>
          {!binding.length || !perturbation.length ? (
            <p className="text-sm text-slate-600">
              Pick at least one binding and one perturbation dataset on the
              Select page to render the Top-N comparison boxplot.
            </p>
          ) : null}
          {topnQuery.error ? (
            <p className="text-red-600">{apiErrorMessage(topnQuery.error)}</p>
          ) : null}
          {topnQuery.isPending &&
          binding.length > 0 &&
          perturbation.length > 0 ? (
            <ComparisonBoxplotSkeleton />
          ) : null}
          {topnQuery.data ? (
            <ComparisonBoxplot resp={topnQuery.data} facetBy={facetBy} />
          ) : null}
        </ErrorBoundary>
      </div>
    </section>
  );
}

function clampNumber(
  raw: string | null,
  fallback: number,
  lo: number,
  hi: number,
): number {
  if (raw === null || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
