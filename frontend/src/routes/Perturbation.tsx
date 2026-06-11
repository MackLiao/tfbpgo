import { useEffect, useMemo } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, apiErrorMessage } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { ActivePairRegulatorPicker } from "@/components/ActivePairRegulatorPicker";
import { PerturbationSidebar } from "@/components/PerturbationSidebar";
import { PerturbationCorrBoxplot } from "@/plots/PerturbationCorrBoxplot";
import { PerturbationScatterRow } from "@/plots/PerturbationScatterRow";
import { PlotSkeleton } from "@/components/PlotSkeleton";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Perturbation route — pairwise correlation boxplot + per-pair scatter grid.
//
// Parity reference:
// reference/tfbpshiny/modules/perturbation/server/workspace.py (lines
// 199-581). Shape mirrors the Binding route 1:1 (only the data path differs):
//   1. Sidebar with Column (effect/pvalue) + Correlation (pearson/spearman)
//      radios + RegulatorPicker. Sidebar values are URL-backed (?col=, ?corr=,
//      ?regulator=) so the page is fully deep-linkable.
//   2. Top: pairwise correlation boxplot. Each pair gets one go.Box trace;
//      points are jittered; the currently-selected regulator is highlighted
//      as a large black dot overlay. Clicking any dot writes the locus tag
//      back to ?regulator=, replacing Shiny's post_script JS bridge.
//   3. Between the boxplot and the scatter row: a "regulator not found in:
//      ..." notice listing datasets whose pairs had no row for the selected
//      regulator (workspace.py:429-469).
//   4. Bottom: one Plotly scatter per active dataset pair, fixed 400x400 in
//      a flex-wrap row.

const DEFAULT_COL: "effect" | "pvalue" = "effect";
const DEFAULT_METHOD: "pearson" | "spearman" = "pearson";

function parseCol(raw: string | null): "effect" | "pvalue" {
  return raw === "pvalue" ? "pvalue" : DEFAULT_COL;
}
function parseMethod(raw: string | null): "pearson" | "spearman" {
  return raw === "spearman" ? "spearman" : DEFAULT_METHOD;
}

export function Perturbation() {
  const [params, setParams] = useSearchParams();
  const reg = params.get("regulator");
  // URL state uses data-type-keyed names so Binding and Perturbation routes
  // can share a URL: ?binding=...&perturbation=...&regulator=...
  const datasets = (params.get("perturbation") ?? "").split(",").filter(Boolean);
  const filters = params.get("filters") ?? "";
  const col = parseCol(params.get("col"));
  const method = parseMethod(params.get("corr"));

  // Build the db_name → display_name lookup once per render. The /datasets
  // call is already cached for the lifetime of the artifact version, so this
  // is effectively free after the first render.
  const datasetsQuery = useQuery({
    queryKey: qk.datasets(),
    queryFn: ({ signal }) => api.datasets(signal),
  });
  const datasetDisplay = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of datasetsQuery.data?.datasets ?? []) {
      map.set(d.dbName, d.displayName);
    }
    return (dbName: string): string => map.get(dbName) ?? dbName;
  }, [datasetsQuery.data]);

  const corrQuery = useQuery({
    queryKey: qk.perturbationCorrelations(datasets, method, col, filters),
    queryFn: ({ signal }) => {
      const base = { datasets, method, col };
      return api.perturbationCorrelations(filters ? { ...base, filters } : base, signal);
    },
    enabled: datasets.length >= 2,
  });

  const setRegulator = (tag: string): void => {
    const next = new URLSearchParams(params);
    next.set("regulator", tag);
    setParams(next);
  };
  const setCol = (next: "effect" | "pvalue"): void => {
    const np = new URLSearchParams(params);
    np.set("col", next);
    setParams(np);
  };
  const setMethod = (next: "pearson" | "spearman"): void => {
    const np = new URLSearchParams(params);
    np.set("corr", next);
    setParams(np);
  };

  // P-2/P-3: the regulators present in the loaded correlation pairs, sorted by
  // display label (symbol) — the picker's choice list.
  const sortedRegulators = useMemo(() => {
    const display = corrQuery.data?.regulatorDisplay ?? {};
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const pair of corrQuery.data?.pairs ?? []) {
      for (const pt of pair.points) {
        if (seen.has(pt.regulatorLocusTag)) continue;
        seen.add(pt.regulatorLocusTag);
        tags.push(pt.regulatorLocusTag);
      }
    }
    tags.sort((a, b) =>
      (display[a] ?? a).toLowerCase().localeCompare((display[b] ?? b).toLowerCase()),
    );
    return tags;
  }, [corrQuery.data]);

  // P-2/P-3: default-regulator auto-select + stale-selection reconcile (Shiny's
  // workspace.py:374-388 `default = current if current in choices else
  // next(iter(choices))`). When ?regulator= is unset or no longer in the loaded
  // set, select the first sorted regulator so the scatter + overlay render
  // immediately. `replace: true` keeps it out of history; the in-set guard
  // prevents clobbering a manual pick and avoids an update loop.
  useEffect(() => {
    const first = sortedRegulators[0];
    if (first === undefined) return;
    if (reg && sortedRegulators.includes(reg)) return;
    const next = new URLSearchParams(params);
    next.set("regulator", first);
    setParams(next, { replace: true });
  }, [sortedRegulators, reg, params, setParams]);

  // Per-dataset sample-conditions fetch — see Binding.tsx for the
  // pattern. Feeds the selected-regulator overlay hovertext.
  const participatingDatasets = useMemo<string[]>(() => {
    if (!corrQuery.data) return [];
    const s = new Set<string>();
    for (const p of corrQuery.data.pairs) {
      s.add(p.dbA);
      s.add(p.dbB);
    }
    return [...s].sort();
  }, [corrQuery.data]);

  const sampleCondQueries = useQueries({
    queries: participatingDatasets.map((db) => ({
      queryKey: qk.sampleConditions(db),
      queryFn: ({ signal }) => api.sampleConditions({ db }, signal),
    })),
  });

  const sampleConditionsByDB = useMemo<Record<string, Record<string, string>>>(() => {
    const out: Record<string, Record<string, string>> = {};
    participatingDatasets.forEach((db, i) => {
      const data = sampleCondQueries[i]?.data;
      if (data) out[db] = data.labels;
    });
    return out;
  }, [participatingDatasets, sampleCondQueries]);

  // Compute the set of datasets that had no row for the selected regulator
  // (mirrors workspace.py:429-469). A dataset is "missing" only if EVERY
  // pair it participates in lacks the regulator — matches Shiny's
  // `failed - succeeded` set algebra.
  const missingDatasetNames = useMemo<string[]>(() => {
    if (!reg || !corrQuery.data) return [];
    const succeeded = new Set<string>();
    const participating = new Set<string>();
    for (const pair of corrQuery.data.pairs) {
      participating.add(pair.dbA);
      participating.add(pair.dbB);
      const hit = pair.points.some((p) => p.regulatorLocusTag === reg);
      if (hit) {
        succeeded.add(pair.dbA);
        succeeded.add(pair.dbB);
      }
    }
    const missing: string[] = [];
    for (const db of participating) {
      if (!succeeded.has(db)) missing.push(datasetDisplay(db));
    }
    missing.sort();
    return missing;
  }, [reg, corrQuery.data, datasetDisplay]);

  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
      <PerturbationSidebar
        regulator={reg}
        onRegulatorChange={setRegulator}
        col={col}
        method={method}
        onColChange={setCol}
        onMethodChange={setMethod}
        regulatorPickerSlot={
          corrQuery.data ? (
            <ActivePairRegulatorPicker
              corr={corrQuery.data}
              value={reg}
              onChange={setRegulator}
              regulatorDisplayMap={corrQuery.data.regulatorDisplay}
            />
          ) : undefined
        }
      />
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Perturbation Correlation</h1>
        <ErrorBoundary>
          {datasets.length < 2 ? (
            <p className="text-sm text-slate-600">
              Select at least two perturbation datasets to see correlations.
            </p>
          ) : null}
          {corrQuery.error ? (
            <p className="text-red-600">{apiErrorMessage(corrQuery.error)}</p>
          ) : null}
          {datasets.length >= 2 && corrQuery.isPending ? <PlotSkeleton /> : null}
          {corrQuery.data ? (
            <PerturbationCorrBoxplot
              resp={corrQuery.data}
              selectedRegulator={reg}
              datasetDisplay={datasetDisplay}
              sampleConditionsByDB={sampleConditionsByDB}
              onRegulatorClick={setRegulator}
              regulatorDisplayMap={corrQuery.data.regulatorDisplay}
            />
          ) : null}
          {reg && missingDatasetNames.length > 0 ? (
            <p className="text-sm text-slate-500">
              {reg} was not found in: {missingDatasetNames.join(", ")}. Pairs
              involving these datasets are omitted.
            </p>
          ) : null}
          {reg && datasets.length >= 2 ? (
            <>
              <hr className="border-slate-200" />
              <PerturbationScatterRow
                regulator={reg}
                datasets={datasets}
                method={method}
                col={col}
                filters={filters}
                datasetDisplay={datasetDisplay}
              />
            </>
          ) : null}
        </ErrorBoundary>
      </div>
    </section>
  );
}
