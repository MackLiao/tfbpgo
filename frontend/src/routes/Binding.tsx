import { useEffect, useMemo } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, apiErrorMessage } from "@/api/client";
import type { CorrMethod, MeasurementCol } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { ActivePairRegulatorPicker } from "@/components/ActivePairRegulatorPicker";
import { BindingSidebar } from "@/components/BindingSidebar";
import { BindingCorrBoxplot } from "@/plots/BindingCorrBoxplot";
import { BindingScatterRow } from "@/plots/BindingScatterRow";
import { PlotSkeleton } from "@/components/PlotSkeleton";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Binding route — pairwise correlation boxplot + per-pair scatter grid.
//
// Parity reference: reference/tfbpshiny/modules/binding/server/workspace.py
// (lines 218-610). Shape:
//   1. Sidebar with Column (effect/pvalue) + Correlation (pearson/spearman)
//      radios + RegulatorPicker. Sidebar values are URL-backed (?col=, ?corr=,
//      ?regulator=) so the page is fully deep-linkable.
//   2. Top: pairwise correlation boxplot. Each pair gets one go.Box trace;
//      points are jittered; the currently-selected regulator is highlighted
//      as a large black dot overlay. Clicking any dot writes the locus tag
//      back to ?regulator=, replacing Shiny's post_script JS bridge.
//   3. Between the boxplot and the scatter row: a "regulator not found in:
//      ..." notice listing datasets whose pairs had no row for the selected
//      regulator (workspace.py:451-491).
//   4. Bottom: one Plotly scatter per active dataset pair, fixed 400x400 in
//      a flex-wrap row.

// Defaults changed in the 2026-06-11 parity pass (BIND-5/BIND-6): the binding
// module now first-loads on the -log10(p) measurement with Spearman ranks,
// matching reference DEFAULT_COL_PREFERENCE="log10pval" / DEFAULT_CORR_TYPE=
// "spearman". parseCol accepts all three measurement kinds; anything else
// (including a stale bookmarked ?col=) falls back to the new default.
const DEFAULT_COL: MeasurementCol = "log10pval";
const DEFAULT_METHOD: CorrMethod = "spearman";

function parseCol(raw: string | null): MeasurementCol {
  return raw === "effect" || raw === "pvalue" || raw === "log10pval" ? raw : DEFAULT_COL;
}
function parseMethod(raw: string | null): CorrMethod {
  return raw === "pearson" || raw === "spearman" ? raw : DEFAULT_METHOD;
}

export function Binding() {
  const [params, setParams] = useSearchParams();
  const reg = params.get("regulator");
  // URL state uses data-type-keyed names so Binding and Perturbation routes
  // can share a URL: ?binding=...&perturbation=...&regulator=...
  const datasets = (params.get("binding") ?? "").split(",").filter(Boolean);
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
    queryKey: qk.bindingCorr(datasets, method, col, filters),
    queryFn: ({ signal }) => {
      const base = { datasets, method, col };
      return api.bindingCorr(filters ? { ...base, filters } : base, signal);
    },
    enabled: datasets.length >= 2,
  });

  const setRegulator = (tag: string): void => {
    const next = new URLSearchParams(params);
    next.set("regulator", tag);
    setParams(next);
  };
  const setCol = (next: MeasurementCol): void => {
    const np = new URLSearchParams(params);
    np.set("col", next);
    setParams(np);
  };
  const setMethod = (next: CorrMethod): void => {
    const np = new URLSearchParams(params);
    np.set("corr", next);
    setParams(np);
  };

  // B-3/P-3: the regulators present in the loaded correlation pairs, sorted by
  // display label (symbol) case-insensitively — the picker's choice list.
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

  // B-3/P-2/P-3: default-regulator auto-select + stale-selection reconcile.
  // Mirrors Shiny's regulator_selector `default = current if current in choices
  // else next(iter(choices))` (workspace.py:400): when ?regulator= is unset or
  // no longer in the loaded set, select the first sorted regulator so the
  // scatter grid + black-dot overlay render immediately instead of staying
  // blank. `replace: true` keeps it out of the back-button history. The guard
  // (reg already in set → no-op) prevents clobbering a manual pick and avoids
  // an update loop.
  useEffect(() => {
    const first = sortedRegulators[0];
    if (first === undefined) return;
    if (reg && sortedRegulators.includes(reg)) return;
    const next = new URLSearchParams(params);
    next.set("regulator", first);
    setParams(next, { replace: true });
  }, [sortedRegulators, reg, params, setParams]);

  // Per-dataset sample-conditions fetch (one query per dataset that
  // participates in any pair). Enabled only once the corr response is
  // loaded so we don't fan out before the page knows what to ask for.
  // Mirrors the Shiny per-dataset `fetch_sample_condition_map` call
  // (workspace.py:103-129) — the result feeds the selected-regulator
  // overlay hovertext in BindingCorrBoxplot.
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
  // (mirrors workspace.py:451-491). A dataset is "missing" only if EVERY
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
      <BindingSidebar
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
        <h1 className="text-2xl font-semibold">Binding Correlation</h1>
        <ErrorBoundary>
          {datasets.length < 2 ? (
            <p className="text-sm text-slate-600">
              Select at least two binding datasets to see correlations.
            </p>
          ) : null}
          {corrQuery.error ? (
            <p className="text-red-600">{apiErrorMessage(corrQuery.error)}</p>
          ) : null}
          {datasets.length >= 2 && corrQuery.isPending ? <PlotSkeleton /> : null}
          {corrQuery.data ? (
            <BindingCorrBoxplot
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
              <BindingScatterRow
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
