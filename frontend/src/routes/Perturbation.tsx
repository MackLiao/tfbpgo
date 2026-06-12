import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, apiErrorMessage } from "@/api/client";
import type { CorrMethod, MeasurementCol } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { ActivePairRegulatorPicker } from "@/components/ActivePairRegulatorPicker";
import { PerturbationSidebar } from "@/components/PerturbationSidebar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CorrelationMatrix, pairKey } from "@/plots/CorrelationMatrix";
import { PerturbationCorrBoxplot } from "@/plots/PerturbationCorrBoxplot";
import { PerturbationScatterRow } from "@/plots/PerturbationScatterRow";
import { PlotSkeleton } from "@/components/PlotSkeleton";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Perturbation route — restructured (PERT-2) into three tabs gated on an
// explicit pair selection, mirroring the reference Perturbation rewrite:
//   reference/tfbpshiny/modules/perturbation/ui.py (3-tab navset) and
//   reference/tfbpshiny/modules/perturbation/server/workspace.py (pending vs
//   committed pair selection). Structurally identical to the Binding route
//   (see Binding.tsx) — only the data path (/perturbation/correlations +
//   /perturbation/scatter) and the first-load defaults differ.
//
// Tabs:
//   1. Correlation Matrix — upper-triangle matrix of active perturbation
//      datasets; each interactive cell shows the pair's MEDIAN per-regulator
//      correlation (derived client-side from /perturbation/correlations).
//      Clicking a cell toggles its PENDING selection (visual highlight only).
//      "Execute Analysis" commits pending → committed; only committed pairs
//      drive the data renders.
//   2. Pair Distribution — the boxplot, restricted to COMMITTED pairs.
//   3. Gene Scatter — the per-pair scatter grid for COMMITTED pairs + the
//      regulator selector.
//
// State-encoding choice (per task guidance "URL is canonical state"):
//   - COMMITTED pairs → URL (?pairs=dbA__dbB,dbC__dbD). Committed pairs drive
//     the box/scatter data fetches + cache keys and should be deep-linkable.
//   - PENDING pairs → ephemeral component state. The reference's pending_pairs
//     is a transient reactive.value that only drives the matrix highlight; it
//     must toggle instantly without re-fetching, so it is local React state.
//     Execute Analysis copies pending → the URL ?pairs= param (committed).
//
// First-load default: NO pairs committed — the distribution and scatter stay
// empty until the user clicks a matrix cell and runs Execute Analysis.

// Perturbation first-load defaults are effect / pearson — UNLIKE the binding
// module, which the 2026-06-11 parity pass switched to log10pval / spearman.
// The reference perturbation control keeps the old defaults
// (reference/tfbpshiny/modules/perturbation/ui.py:41 selected="effect", :49
// selected="pearson"). The log10pval measurement IS offered as a radio option
// (ui.py:27-29) — it is just not the default. parseCol accepts all three kinds.
const DEFAULT_COL: MeasurementCol = "effect";
const DEFAULT_METHOD: CorrMethod = "pearson";

function parseCol(raw: string | null): MeasurementCol {
  return raw === "effect" || raw === "pvalue" || raw === "log10pval" ? raw : DEFAULT_COL;
}
function parseMethod(raw: string | null): CorrMethod {
  return raw === "pearson" || raw === "spearman" ? raw : DEFAULT_METHOD;
}

// Parse the committed pairs from ?pairs= into canonical `dbA__dbB` keys, keeping
// only those whose BOTH datasets are still in the active selection (a stale
// bookmark referencing a now-deselected dataset must not drive a fetch).
function parseCommittedKeys(raw: string | null, activeDatasets: string[]): Set<string> {
  const active = new Set(activeDatasets);
  const keys = new Set<string>();
  for (const token of (raw ?? "").split(",").filter(Boolean)) {
    const parts = token.split("__");
    if (parts.length !== 2) continue;
    const [a, b] = parts as [string, string];
    if (!active.has(a) || !active.has(b)) continue;
    keys.add(pairKey(a, b));
  }
  return keys;
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

  // Committed pairs (canonical keys) from the URL — drives the box + scatter.
  const committedKeys = useMemo(
    () => parseCommittedKeys(params.get("pairs"), datasets),
    // datasets is derived from params each render; depend on the raw strings so
    // the memo recomputes when either the pairs param or the dataset set moves.
    [params, datasets.join(",")],
  );

  // Active tab — kept in the URL (?tab=) so a deep link can land on any tab.
  // Anything unrecognized falls back to the matrix tab so a stale/garbage value
  // never leaves every TabsContent hidden.
  const rawTab = params.get("tab");
  const tab =
    rawTab === "distribution" || rawTab === "scatter" ? rawTab : "matrix";
  const setTab = (next: string): void => {
    const np = new URLSearchParams(params);
    np.set("tab", next);
    setParams(np, { replace: true });
  };

  // Pending (highlight-only) selection — ephemeral component state. Seeded from
  // the committed URL set so a deep link shows its committed pairs already
  // highlighted; thereafter the user can toggle freely before re-committing.
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set(committedKeys));

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

  // Prune pending keys that reference pairs no longer present in the loaded
  // corr response (a dataset was deselected, or its pair produced no rows).
  useEffect(() => {
    if (!corrQuery.data) return;
    const valid = new Set(
      (corrQuery.data.pairs ?? []).map((p) => pairKey(p.dbA, p.dbB)),
    );
    setPendingKeys((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const k of prev) {
        if (valid.has(k)) next.add(k);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [corrQuery.data]);

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

  // Toggle a pair's pending membership (instant highlight, no fetch).
  const togglePending = (key: string): void => {
    setPendingKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Execute Analysis: commit pending → the URL ?pairs= param. This is the only
  // action that changes which pairs the box/scatter render.
  const executeAnalysis = (): void => {
    const np = new URLSearchParams(params);
    const joined = [...pendingKeys].sort().join(",");
    if (joined) np.set("pairs", joined);
    else np.delete("pairs");
    setParams(np);
  };

  // True when the pending selection differs from what is currently committed —
  // drives the "you have unapplied changes" hint + Execute enablement.
  const hasUnapplied = useMemo(() => {
    if (pendingKeys.size !== committedKeys.size) return true;
    for (const k of pendingKeys) if (!committedKeys.has(k)) return true;
    return false;
  }, [pendingKeys, committedKeys]);

  // Committed pairs as [dbA, dbB] tuples (canonical, sorted) for the scatter row.
  const committedPairTuples = useMemo<Array<[string, string]>>(() => {
    return [...committedKeys].map((k) => {
      const [a, b] = k.split("__") as [string, string];
      return [a, b];
    });
  }, [committedKeys]);

  // P-2/P-3: the regulators present in the loaded correlation pairs, sorted by
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

  // P-2/P-3: default-regulator auto-select + stale-selection reconcile. When
  // ?regulator= is unset or no longer in the loaded set, select the first
  // sorted regulator so the scatter + overlay render immediately. `replace:
  // true` keeps it out of history; the in-set guard prevents clobbering a
  // manual pick and avoids an update loop.
  useEffect(() => {
    const first = sortedRegulators[0];
    if (first === undefined) return;
    if (reg && sortedRegulators.includes(reg)) return;
    const next = new URLSearchParams(params);
    next.set("regulator", first);
    setParams(next, { replace: true });
  }, [sortedRegulators, reg, params, setParams]);

  // Per-dataset sample-conditions fetch — see Binding.tsx for the pattern.
  // Feeds the selected-regulator overlay hovertext in PerturbationCorrBoxplot.
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

  // Compute the set of datasets that had no row for the selected regulator,
  // scoped to the COMMITTED pairs. A dataset is "missing" only if EVERY
  // committed pair it participates in lacks the regulator — matches Shiny's
  // `failed - succeeded` set algebra.
  const missingDatasetNames = useMemo<string[]>(() => {
    if (!reg || !corrQuery.data) return [];
    const committedPairs = (corrQuery.data.pairs ?? []).filter((p) =>
      committedKeys.has(pairKey(p.dbA, p.dbB)),
    );
    const succeeded = new Set<string>();
    const participating = new Set<string>();
    for (const pair of committedPairs) {
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
  }, [reg, corrQuery.data, committedKeys, datasetDisplay]);

  const hasCommitted = committedKeys.size > 0;

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
        {/* "How it works" explanation — verbatim parity with the reference
            sidebar-text block (reference/tfbpshiny/modules/perturbation/ui.py:59-77):
            one intro paragraph + one paragraph per tab. */}
        <div className="space-y-1 text-sm text-slate-600">
          <p>
            Select score and correlation method in the sidebar, then click
            Execute Analysis to compute pairwise correlations across shared
            regulators.
          </p>
          <p>
            The Correlation Matrix tab shows median correlation for each dataset
            pair. Click a cell to select that pair.
          </p>
          <p>
            The Pair Distribution tab shows the per-regulator correlation
            distribution for the selected pair. Click a point to select a
            regulator.
          </p>
          <p>
            The Gene Scatter tab shows per-target scores for the selected
            regulator. Use the dropdown to change the active regulator.
          </p>
        </div>
        <ErrorBoundary>
          {datasets.length < 2 ? (
            <p className="text-sm text-slate-600">
              Select at least two perturbation datasets to see correlations.
            </p>
          ) : null}
          {corrQuery.error ? (
            <p className="text-red-600">{apiErrorMessage(corrQuery.error)}</p>
          ) : null}

          {datasets.length >= 2 ? (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="matrix">Correlation Matrix</TabsTrigger>
                <TabsTrigger value="distribution">Pair Distribution</TabsTrigger>
                <TabsTrigger value="scatter">Gene Scatter</TabsTrigger>
              </TabsList>

              {/* --- Correlation Matrix tab --- */}
              <TabsContent value="matrix">
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={executeAnalysis}
                      disabled={!hasUnapplied}
                      className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Execute Analysis
                    </button>
                    {hasUnapplied ? (
                      <span className="text-sm text-amber-700">
                        Selection changed. Click Execute Analysis to apply.
                      </span>
                    ) : hasCommitted ? (
                      <span className="text-sm text-slate-500">
                        {committedKeys.size} pair
                        {committedKeys.size === 1 ? "" : "s"} committed.
                      </span>
                    ) : (
                      <span className="text-sm text-slate-500">
                        Click a cell to select a pair.
                      </span>
                    )}
                  </div>
                  {corrQuery.isPending ? (
                    <PlotSkeleton />
                  ) : corrQuery.data ? (
                    <CorrelationMatrix
                      resp={corrQuery.data}
                      datasets={datasets}
                      datasetDisplay={datasetDisplay}
                      pendingKeys={pendingKeys}
                      onToggle={togglePending}
                    />
                  ) : null}
                </div>
              </TabsContent>

              {/* --- Pair Distribution tab --- */}
              <TabsContent value="distribution">
                {!hasCommitted ? (
                  <p className="text-sm text-slate-600">
                    Select cells in the Correlation Matrix and click Execute
                    Analysis to view their distributions.
                  </p>
                ) : corrQuery.isPending ? (
                  <PlotSkeleton />
                ) : corrQuery.data ? (
                  <PerturbationCorrBoxplot
                    resp={corrQuery.data}
                    selectedRegulator={reg}
                    datasetDisplay={datasetDisplay}
                    sampleConditionsByDB={sampleConditionsByDB}
                    onRegulatorClick={setRegulator}
                    regulatorDisplayMap={corrQuery.data.regulatorDisplay}
                    committedPairKeys={committedKeys}
                  />
                ) : null}
              </TabsContent>

              {/* --- Gene Scatter tab --- */}
              <TabsContent value="scatter">
                {!hasCommitted ? (
                  <p className="text-sm text-slate-600">
                    Select cells in the Correlation Matrix and click Execute
                    Analysis to view gene-level scatter plots.
                  </p>
                ) : !reg ? (
                  <p className="text-sm text-slate-600">
                    Select a regulator to view gene-level scatter plots.
                  </p>
                ) : (
                  <>
                    {missingDatasetNames.length > 0 ? (
                      <p className="text-sm text-slate-500">
                        {reg} was not found in: {missingDatasetNames.join(", ")}.
                        Pairs involving these datasets are omitted.
                      </p>
                    ) : null}
                    <PerturbationScatterRow
                      regulator={reg}
                      pairs={committedPairTuples}
                      method={method}
                      col={col}
                      filters={filters}
                      datasetDisplay={datasetDisplay}
                    />
                  </>
                )}
              </TabsContent>
            </Tabs>
          ) : null}
        </ErrorBoundary>
      </div>
    </section>
  );
}
