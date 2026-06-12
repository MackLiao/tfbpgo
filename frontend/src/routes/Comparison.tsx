import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, apiErrorMessage, type ResponsivenessPreset } from "@/api/client";
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
// URL is the canonical state: all sidebar params (`top_n`, `preset`,
// `facet_by`) are deep-linkable and writeable. The DTO tab from
// the previous iteration is removed — Shiny has no equivalent, see
// docs/parity/comparison.md §2 row 18. (`api.dto` remains in client.ts for
// potential future use but is unused on the frontend.)
//
// CMP-4/CMP-5: The old `effect` / `pvalue` URL params and sliders have been
// replaced by a `preset` param ("Relaxed" | "Stringent"), mirroring the
// reference's input_radio_buttons("responsiveness_preset", ...) in ui.py:33-54.
// DEFAULT_RESPONSIVENESS_PRESET = "Relaxed" (reference/tfbpshiny/utils/vdb_init.py:174).
//
// URL behaviour: when `?preset=` is absent, defaults to "Relaxed" but the
// param is NOT written into the URL proactively — it only appears once the
// user has explicitly changed the control, matching how `top_n` and other
// params behave in this codebase (they start absent and are set on first
// explicit user interaction). The query-key and API call always use the
// resolved value ("Relaxed" by default), so caching is correct regardless of
// whether the param is present in the URL.

const DEFAULT_PRESET: ResponsivenessPreset = "Relaxed";

const DEFAULTS = {
  topN: 25,
  preset: DEFAULT_PRESET,
  facetBy: "binding" as const,
};

function parseFacetBy(raw: string | null): "binding" | "perturbation" {
  return raw === "perturbation" ? "perturbation" : "binding";
}

function parsePreset(raw: string | null): ResponsivenessPreset {
  return raw === "Stringent" ? "Stringent" : "Relaxed";
}

export function Comparison() {
  const [params, setParams] = useSearchParams();
  const binding = (params.get("binding") ?? "").split(",").filter(Boolean);
  const perturbation = (params.get("perturbation") ?? "")
    .split(",")
    .filter(Boolean);
  const topN = clampNumber(params.get("top_n"), DEFAULTS.topN, 1, 500);
  const preset = parsePreset(params.get("preset"));
  const facetBy = parseFacetBy(params.get("facet_by"));
  const filters = params.get("filters") ?? "";

  const topnQuery = useQuery({
    queryKey: qk.topn(binding, perturbation, topN, preset, filters),
    queryFn: ({ signal }) => {
      const base = { binding, perturbation, top_n: topN, preset };
      return api.topn(filters ? { ...base, filters } : base, signal);
    },
    enabled: binding.length > 0 && perturbation.length > 0,
  });

  const handleSidebarChange = (next: ComparisonSidebarChange): void => {
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      if (next.topN !== undefined) out.set("top_n", String(next.topN));
      if (next.preset !== undefined) out.set("preset", next.preset);
      if (next.facetBy !== undefined) out.set("facet_by", next.facetBy);
      return out;
    });
  };

  return (
    <section className="grid grid-cols-[260px_1fr] gap-4">
      <ComparisonSidebar
        topN={topN}
        preset={preset}
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
