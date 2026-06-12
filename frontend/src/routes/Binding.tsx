import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, apiErrorMessage } from "@/api/client";
import type { CorrMethod, MeasurementCol } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { ActivePairRegulatorPicker } from "@/components/ActivePairRegulatorPicker";
import { BindingSidebar } from "@/components/BindingSidebar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CorrelationMatrix, pairKey } from "@/plots/CorrelationMatrix";
import { BindingCorrBoxplot } from "@/plots/BindingCorrBoxplot";
import { BindingScatterRow } from "@/plots/BindingScatterRow";
import { PlotSkeleton } from "@/components/PlotSkeleton";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Binding route — restructured (BIND-2) into three tabs gated on an explicit
// pair selection, mirroring the reference Binding rewrite:
//   reference/tfbpshiny/modules/binding/ui.py (3-tab navset) and
//   reference/tfbpshiny/modules/binding/server/workspace.py (pending vs
//   committed pair selection).
//
// Tabs:
//   1. Correlation Matrix — upper-triangle matrix of active binding datasets;
//      each interactive cell shows the pair's MEDIAN per-regulator correlation
//      (derived client-side from /binding/corr). Clicking a cell toggles its
//      PENDING selection (visual highlight only). "Execute Analysis" commits
//      pending → committed; only committed pairs drive the data renders.
//   2. Pair Distribution — the boxplot, restricted to COMMITTED pairs.
//   3. Gene Scatter — the per-pair scatter grid for COMMITTED pairs + the
//      regulator selector.
//
// State-encoding choice (per task guidance "URL is canonical state"):
//   - COMMITTED pairs → URL (?pairs=dbA__dbB,dbC__dbD). Committed pairs drive
//     the box/scatter data fetches + cache keys and should be deep-linkable, so
//     they live in the URL like every other canonical Binding control.
//   - PENDING pairs → ephemeral component state. The reference's pending_pairs
//     is a transient reactive.value that only drives the matrix highlight
//     (workspace.py:78-79); it must toggle instantly without re-fetching, so it
//     is local React state, not URL state. Execute Analysis copies pending →
//     the URL ?pairs= param (committed).
//
// First-load default: NO pairs committed. Mirrors workspace.py:351-376
// (_init_selected_pairs): "No default pair is seeded: the matrix selection is
// the single source of truth, so the distribution and scatter stay empty until
// the user clicks a matrix cell" (and runs Execute Analysis to commit it).

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

// Parse the committed pairs from ?pairs= into canonical `dbA__dbB` keys, keeping
// only those whose BOTH datasets are still in the active selection (a stale
// bookmark referencing a now-deselected dataset must not drive a fetch). This
// is the URL equivalent of workspace.py:351-376 pruning stale committed pairs.
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

export function Binding() {
  const [params, setParams] = useSearchParams();
  const reg = params.get("regulator");
  // URL state uses data-type-keyed names so Binding and Perturbation routes
  // can share a URL: ?binding=...&perturbation=...&regulator=...
  const datasets = (params.get("binding") ?? "").split(",").filter(Boolean);
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
  // Clamp to the known set: a stale/garbage value (e.g. ?tab=foo) would leave
  // every TabsContent hidden — tab bar shown, empty panel, no active tab — so
  // anything unrecognized falls back to the matrix tab.
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
    queryKey: qk.bindingCorr(datasets, method, col, filters),
    queryFn: ({ signal }) => {
      const base = { datasets, method, col };
      return api.bindingCorr(filters ? { ...base, filters } : base, signal);
    },
    enabled: datasets.length >= 2,
  });

  // Prune pending keys that reference pairs no longer present in the loaded
  // corr response (a dataset was deselected, or its pair produced no rows).
  // Mirrors workspace.py:351-376 pruning of stale pending_pairs on task success.
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

  // Toggle a pair's pending membership (instant highlight, no fetch). Mirrors
  // workspace.py:619-628 (_on_cell_click): add when absent, remove when present.
  const togglePending = (key: string): void => {
    setPendingKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Execute Analysis: commit pending → the URL ?pairs= param. This is the only
  // action that changes which pairs the box/scatter render (workspace.py:245-285
  // _on_execute → committed_pairs.set(list(pending_pairs()))).
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
  // else next(iter(choices))` (workspace.py:850-869): when ?regulator= is unset
  // or no longer in the loaded set, select the first sorted regulator so the
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
  // Mirrors the Shiny per-dataset `fetch_sample_condition_map` call — the
  // result feeds the selected-regulator overlay hovertext in BindingCorrBoxplot.
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
  // scoped to the COMMITTED pairs (mirrors workspace.py:1024-1077
  // scatter_missing_note, which restricts to the committed/visible pairs). A
  // dataset is "missing" only if EVERY committed pair it participates in lacks
  // the regulator — matches Shiny's `failed - succeeded` set algebra.
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
        <p className="text-sm text-slate-600">
          The Correlation Matrix tab shows the median correlation for each
          dataset pair. Click cells to select pairs, then click Execute Analysis
          to view their distributions and gene-level scatter plots.
        </p>
        <ErrorBoundary>
          {datasets.length < 2 ? (
            <p className="text-sm text-slate-600">
              Select at least two binding datasets to see correlations.
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
                  <BindingCorrBoxplot
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
                    <BindingScatterRow
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
