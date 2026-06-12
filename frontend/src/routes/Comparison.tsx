import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, apiErrorMessage, type ResponsivenessPreset } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { ComparisonBoxplot } from "@/plots/ComparisonBoxplot";
import { ComparisonBoxplotSkeleton } from "@/plots/ComparisonBoxplotSkeleton";
import { TopNMatrix, type TopNMatrixSelection } from "@/plots/TopNMatrix";
import {
  PromoterDefinitionsTable,
  AnalysisMethodsTable,
} from "@/plots/ComparisonVariantTables";
import {
  PEAKS_VARIANT_DBS,
  PROMOTER_SET_ORDER,
  PROMOTER_VARIANT_DBS,
  resolveCompareDatasetsDb,
} from "@/lib/comparison-palette";
import {
  ComparisonSidebar,
  type ComparisonSidebarChange,
} from "@/components/ComparisonSidebar";
import { PromoterSetSelector } from "@/components/PromoterSetSelector";
import {
  CompareDatasetsControls,
  type CompareDatasetsMethod,
} from "@/components/CompareDatasetsControls";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import type { Schemas } from "@/api/client";

// Comparison route — restructured (CMP-6 / Task 6a) into a 3-tab navset
// mirroring the reference Comparison rewrite:
//   reference/tfbpshiny/modules/comparison/ui.py (the 3-tab navset + the
//     explanatory bullet text + the Top N / Responsiveness sidebar)
//   reference/tfbpshiny/modules/comparison/server/workspace.py (the Compare
//     Datasets matrix → distribution drill-down).
//
// Tabs (ui.py:160-184):
//   1. Compare Datasets — binding(rows) × perturbation(cols) responsive-ratio
//      MATRIX; each cell is the median percent-responsive for that pair. Click a
//      row/column header to drill into a distribution (ComparisonBoxplot).
//   2. Compare Promoter Definitions — one table per perturbation; rows = binding
//      datasets, columns = promoter sets (Kang/Mindel/500bp/Intergenic). Built in
//      ComparisonVariantTables.tsx (Task 6b).
//   3. Compare Analysis Methods — one table per (peaks-eligible primary,
//      perturbation); rows = scoring variants (Promoter Enrichment vs Original
//      Peaks). Built in ComparisonVariantTables.tsx (Task 6b).
//
// ALL THREE tabs are driven by the SAME `/comparison/topn` endpoint — they are
// different labelings/groupings of the same topn result, not new backend calls.
// Tabs 2 & 3 run topn over the promoter-set / scoring VARIANT binding datasets
// (now whitelisted in the artifact), batched ONE request per perturbation so
// each stays under the backend's 12-pair cap (see ComparisonVariantTables.tsx).
//
// DELIBERATE DIVERGENCES from the reference:
//   - No "Execute Analysis" gating. The reference gates the topn computation
//     behind an explicit button (ui.py:17-22) because each run is a multi-second
//     off-thread DuckDB sweep; this React app already auto-fetches `/comparison/
//     topn` reactively (and the backend coalesces + caches), so the tables
//     render as soon as their queries land. The sidebar's "Execute Analysis"
//     button is therefore omitted.
//   - The cp promoter-set checkboxes (reference `cp_included_promoter_sets`,
//     workspace.py:552-568) ARE implemented — but as an INLINE control on the
//     Compare Promoter Definitions tab (PromoterSetSelector), not a tab-aware
//     sidebar. Selection is URL-encoded via `?promoterSets=` (absent => DEFAULT
//     all four sets, matching the reference's `selected=all`), and narrows both
//     the table columns and the topn binding-axis fan-out. With ZERO sets
//     selected we render an explicit empty-state ("Select at least one promoter
//     set…") rather than the reference's blank output — a small UX improvement.
//   - The cd Binding Method + Promoter Set selectors (reference
//     `cd_binding_method` / `cd_promoter_set`, workspace.py:531-549) ARE
//     implemented — also as an INLINE control (CompareDatasetsControls) above the
//     Compare Datasets matrix. They re-resolve each primary row to its scoring
//     variant (resolveCompareDatasetsDb): Promoter Enrichment + Kang is the base
//     matrix (the prior behaviour), other promoter sets swap to the variant db,
//     and Peaks swaps to the peaks variant (dropping primaries that have none).
//     URL-encoded via `?cd_method=` / `?cd_promoter_set=` (absent => the defaults
//     Promoter Enrichment / Kang). The matrix still labels rows by the PRIMARY
//     base label; we re-key the topn rows variant→primary so the matrix + the
//     drill-down boxplot read/label in primary space.
//   - Still divergent (the reference's other per-tab sidebar selectors are not
//     ported; the dataset selection itself comes from the shared
//     `?binding=`/`?perturbation=` URL state on the Select page):
//       · Compare Analysis Methods `cm_binding_dataset` single-select
//         (workspace.py:574-580) — we render ALL selected peaks-eligible
//         primaries rather than one chosen dataset — and `cm_promoter_set`
//         (workspace.py:582-587).
//
// STATE-ENCODING choice:
//   - Active tab → URL (`?tab=`), like Binding.tsx, so a deep link can land on
//     any tab. Unknown values normalize to the first tab ("datasets").
//   - Matrix↔distribution drill-down SELECTION → ephemeral COMPONENT state. The
//     reference holds it in `reactive.value` (workspace.py:343-344), not the
//     URL: it does not change WHAT is fetched (the topn query loads all pairs at
//     once and the selection only filters the already-loaded result client-side,
//     so no re-fetch / cache key depends on it), and it is a transient view
//     toggle. Contrast the prior binding-matrix task, which put COMMITTED pairs
//     in `?pairs=` precisely because those drive the data fetch + cache key.
//
// URL behaviour (preset): when `?preset=` is absent, defaults to "Relaxed" but
// is not written into the URL proactively — it only appears once the user
// explicitly changes the control, matching `top_n`. The query-key
// and API call always use the resolved value, so caching is correct regardless.

const DEFAULT_PRESET: ResponsivenessPreset = "Relaxed";

const DEFAULTS = {
  topN: 25,
  preset: DEFAULT_PRESET,
};

type ComparisonTab = "datasets" | "promoters" | "methods";

// Normalize ?tab= to the known set; anything unrecognized (stale bookmark,
// garbage) falls back to the first tab so we never show an empty tabpanel.
function parseTab(raw: string | null): ComparisonTab {
  return raw === "promoters" || raw === "methods" ? raw : "datasets";
}

// Parse the `?promoterSets=` param for the Compare Promoter Definitions tab.
// Mirrors the reference's `cp_included_promoter_sets` checkbox group default of
// ALL sets selected (workspace.py:566 `selected=list(_PROMOTER_SET_ALIAS)`):
//   - absent (null)        → DEFAULT: all four sets, in canonical order.
//   - present-but-empty "" → NONE selected (the user unchecked every box).
//   - "Kang,500bp"         → only the listed sets, canonical-ordered, invalid
//                            tokens dropped (filter PROMOTER_SET_ORDER by membership).
function parsePromoterSets(raw: string | null): string[] {
  if (raw === null) return [...PROMOTER_SET_ORDER];
  const set = new Set(raw.split(",").filter(Boolean));
  return PROMOTER_SET_ORDER.filter((ps) => set.has(ps));
}

function parsePreset(raw: string | null): ResponsivenessPreset {
  return raw === "Stringent" ? "Stringent" : "Relaxed";
}

const DEFAULT_CD_METHOD: CompareDatasetsMethod = "Promoter Enrichment";
const DEFAULT_CD_PROMOTER_SET = "Kang";

// Parse the Compare Datasets `?cd_method=` / `?cd_promoter_set=` params. Both
// default to the base/Kang matrix when absent or unrecognized, matching the
// reference's `selected="Promoter Enrichment"` / `selected="Kang"`
// (workspace.py:541 / 549).
function parseCdMethod(raw: string | null): CompareDatasetsMethod {
  return raw === "Peaks" ? "Peaks" : DEFAULT_CD_METHOD;
}
function parseCdPromoterSet(raw: string | null): string {
  return raw !== null && PROMOTER_SET_ORDER.includes(raw)
    ? raw
    : DEFAULT_CD_PROMOTER_SET;
}

export function Comparison() {
  const [params, setParams] = useSearchParams();
  const binding = (params.get("binding") ?? "").split(",").filter(Boolean);
  const perturbation = (params.get("perturbation") ?? "")
    .split(",")
    .filter(Boolean);
  // Primary binding datasets for the variant tabs: drop promoter-set variants
  // (Mindel/500bp/Intergenic) and peaks variants so the tab's own enumeration
  // re-derives them. Mirrors `binding_primary` in workspace.py:524-530 /
  // 672-678 (the `not in _variant_dbs` and `not in peaks` filters).
  const bindingPrimaries = binding.filter(
    (b) => !PROMOTER_VARIANT_DBS.has(b) && !PEAKS_VARIANT_DBS.has(b),
  );
  const topN = clampNumber(params.get("top_n"), DEFAULTS.topN, 1, 500);
  const preset = parsePreset(params.get("preset"));
  const filters = params.get("filters") ?? "";
  const tab = parseTab(params.get("tab"));
  // Promoter sets to compare on the Compare Promoter Definitions tab. Absent
  // param => all four (the reference's checkbox-group default).
  const selectedPromoterSets = parsePromoterSets(params.get("promoterSets"));

  // Compare Datasets binding-method + promoter-set selection (absent => the
  // base/Kang matrix, i.e. the behaviour before this control existed). See
  // CompareDatasetsControls + resolveCompareDatasetsDb.
  const cdMethod = parseCdMethod(params.get("cd_method"));
  const cdPromoterSet = parseCdPromoterSet(params.get("cd_promoter_set"));

  // db_name → display_name lookup from /datasets (already cached per artifact
  // version). Declared here because the cd resolver's availability gate
  // (availableDbs) also derives from it. Mirrors workspace.py:326-328.
  const datasetsQuery = useQuery({
    queryKey: qk.datasets(),
    queryFn: ({ signal }) => api.datasets(signal),
  });

  // Set of db_names the artifact actually serves (from /datasets, incl. variant
  // dbs). Threaded into the resolver as the reference's `_available_datasets` +
  // `cd_resolved in BINDING_CONFIGS` guard so a resolved-but-missing variant
  // degrades to Kang instead of 400ing the topn request. `undefined` until the
  // manifest loads → the resolver uses the static maps in the meantime (the
  // common case, where the maps already match the artifact).
  const availableDbs = useMemo<ReadonlySet<string> | undefined>(() => {
    const ds = datasetsQuery.data?.datasets;
    // Gate only against a real, non-empty manifest. An absent (still loading /
    // errored) or empty datasets list => undefined => no gating (the static maps
    // remain the source of truth), so we never drop every row on a degenerate
    // manifest — only drift between the maps and a populated manifest gates.
    if (!ds || ds.length === 0) return undefined;
    const s = new Set<string>();
    for (const d of ds) s.add(d.dbName);
    return s;
  }, [datasetsQuery.data]);

  // Resolve each selected primary to the variant db that supplies its matrix
  // row, dropping primaries that resolve to nothing (Peaks with no peaks
  // variant, or a variant absent from the artifact). Mirrors workspace.py:795-803
  // (`cd_resolved`).
  const cdRows = useMemo<Array<{ primary: string; resolved: string }>>(() => {
    const out: Array<{ primary: string; resolved: string }> = [];
    for (const primary of bindingPrimaries) {
      const resolved = resolveCompareDatasetsDb(
        primary,
        cdMethod,
        cdPromoterSet,
        availableDbs,
      );
      if (resolved !== null) out.push({ primary, resolved });
    }
    return out;
    // bindingPrimaries is re-derived each render; key the memo on its content.
  }, [bindingPrimaries.join(","), cdMethod, cdPromoterSet, availableDbs]);

  const cdResolvedDbs = useMemo(() => cdRows.map((r) => r.resolved), [cdRows]);
  const cdRowPrimaries = useMemo(() => cdRows.map((r) => r.primary), [cdRows]);
  // resolved variant db → primary, for re-keying the topn rows back into the
  // primary "space" the matrix + drill-down label in.
  const resolvedToPrimary = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of cdRows) m.set(r.resolved, r.primary);
    return m;
  }, [cdRows]);

  // Drill-down selection: which row (binding) OR column (perturbation) of the
  // matrix is currently expanded into a distribution. Mutually exclusive.
  // Ephemeral component state — see the state-encoding note in the file header.
  const [selection, setSelection] = useState<TopNMatrixSelection>({
    binding: null,
    perturbation: null,
  });

  // The Compare Datasets matrix queries topn over the RESOLVED variant dbs
  // (cd_method/cd_promoter_set), not the raw primaries. Under the default
  // Promoter Enrichment + Kang, cdResolvedDbs === bindingPrimaries, so this is
  // byte-identical to the prior `binding` query in the common case.
  const topnQuery = useQuery({
    queryKey: qk.topn(cdResolvedDbs, perturbation, topN, preset, filters),
    queryFn: ({ signal }) => {
      const base = { binding: cdResolvedDbs, perturbation, top_n: topN, preset };
      return api.topn(filters ? { ...base, filters } : base, signal);
    },
    enabled: cdResolvedDbs.length > 0 && perturbation.length > 0,
  });

  // db_name → display_name lookup from /datasets (datasetsQuery declared above).
  // Falls back to the db_name when absent. Mirrors workspace.py:326-328.
  const displayName = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of datasetsQuery.data?.datasets ?? []) {
      map.set(d.dbName, d.displayName);
    }
    return (db: string): string => map.get(db) ?? db;
  }, [datasetsQuery.data]);

  // Re-key the topn rows from the resolved variant db back to the PRIMARY db so
  // the matrix rows + drill-down boxplot read/label in primary space (the matrix
  // shows primary base labels regardless of which scoring variant supplies the
  // cell value, and ComparisonBoxplot's bindingLabel/BINDING_ORDER only know the
  // base labels). A no-op when resolved === primary (Promoter Enrichment + Kang).
  const cdResponse = useMemo<Schemas["TopNResponse"] | undefined>(() => {
    if (!topnQuery.data) return undefined;
    const rows = (topnQuery.data.rows ?? []).map((r) => {
      const sep = r.pairKey.indexOf("__");
      if (sep < 0) return r;
      const bDb = r.pairKey.slice(0, sep);
      const primary = resolvedToPrimary.get(bDb);
      if (primary === undefined || primary === bDb) return r;
      // slice(sep) is "__{perturbationDb}", so this rebuilds "{primary}__{pDb}".
      return { ...r, pairKey: `${primary}${r.pairKey.slice(sep)}` };
    });
    return { ...topnQuery.data, rows };
  }, [topnQuery.data, resolvedToPrimary]);

  // Validate the ephemeral drill-down selection against the current data. The
  // selection lives in component state (see the state-encoding note above) and
  // therefore survives ?binding=/?perturbation=/?preset=/?top_n= URL changes —
  // but a stale pick whose dataset was deselected (or whose preset no longer
  // yields that row) would silently render an empty distribution with no
  // explanation. Mirror Binding.tsx's pending-pair pruning (parseCommittedKeys +
  // the corr-response useEffect): when the selected binding/perturbation is no
  // longer present in the current selection arrays OR absent from the loaded
  // topn rows, null the stale pick so the matrix returns to its prompt state.
  useEffect(() => {
    setSelection((prev) => {
      if (prev.binding === null && prev.perturbation === null) return prev;
      const bindingSet = new Set(binding);
      const perturbationSet = new Set(perturbation);
      // Datasets actually present in the loaded topn result (drives the matrix).
      // Use the re-keyed cdResponse so rowBindings are in primary space (the
      // matrix selects primaries). Only enforce the row-presence check once data
      // has landed: while the query is pending (e.g. mid-refetch after a preset
      // change) the rows are momentarily empty, and a still-valid pick must not
      // be nulled then.
      const rows = cdResponse?.rows;
      const rowBindings = new Set<string>();
      const rowPerturbations = new Set<string>();
      for (const r of rows ?? []) {
        const sep = r.pairKey.indexOf("__");
        if (sep < 0) continue;
        rowBindings.add(r.pairKey.slice(0, sep));
        rowPerturbations.add(r.pairKey.slice(sep + 2));
      }
      const inRows = rows !== undefined;
      if (
        prev.binding !== null &&
        (!bindingSet.has(prev.binding) ||
          (inRows && !rowBindings.has(prev.binding)))
      ) {
        return { binding: null, perturbation: null };
      }
      if (
        prev.perturbation !== null &&
        (!perturbationSet.has(prev.perturbation) ||
          (inRows && !rowPerturbations.has(prev.perturbation)))
      ) {
        return { binding: null, perturbation: null };
      }
      return prev;
    });
  }, [binding.join(","), perturbation.join(","), cdResponse]);

  const setTab = (next: string): void => {
    const np = new URLSearchParams(params);
    np.set("tab", next);
    setParams(np, { replace: true });
  };

  // Write the selected promoter sets to `?promoterSets=`. Keep the URL clean +
  // round-trippable through parsePromoterSets:
  //   - all four selected  → DELETE the param (clean URL == the default).
  //   - none selected      → set "" (present-but-empty), distinct from absent so
  //                          parsePromoterSets reads it as NONE, not the default.
  //   - a subset           → join the canonical-ordered list.
  // (URLSearchParams preserves an empty-valued param: set("k","") serializes to
  // "k=" and re-reads as "" — verified — so no "none" sentinel is needed.)
  const setPromoterSets = (next: string[]): void => {
    const np = new URLSearchParams(params);
    if (next.length === PROMOTER_SET_ORDER.length) {
      np.delete("promoterSets");
    } else if (next.length === 0) {
      np.set("promoterSets", "");
    } else {
      np.set("promoterSets", next.join(","));
    }
    setParams(np);
  };

  // Write the Compare Datasets selectors to the URL; absent param == the default
  // (a clean URL for the base/Kang matrix).
  const setCdMethod = (next: CompareDatasetsMethod): void => {
    const np = new URLSearchParams(params);
    if (next === DEFAULT_CD_METHOD) np.delete("cd_method");
    else np.set("cd_method", next);
    setParams(np);
  };
  const setCdPromoterSet = (next: string): void => {
    const np = new URLSearchParams(params);
    if (next === DEFAULT_CD_PROMOTER_SET) np.delete("cd_promoter_set");
    else np.set("cd_promoter_set", next);
    setParams(np);
  };

  const handleSidebarChange = (next: ComparisonSidebarChange): void => {
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      if (next.topN !== undefined) out.set("top_n", String(next.topN));
      if (next.preset !== undefined) out.set("preset", next.preset);
      return out;
    });
  };

  // Build the drill-down response + facet axis from the current selection.
  // - binding selected   → that binding's ROW: keep its pairs, facet by binding
  //                        (one facet = the binding, x = perturbation sources).
  // - perturbation selected → that perturbation's COLUMN: keep its pairs, facet
  //                        by perturbation (one facet, x = binding sources).
  // Mirrors workspace.py:1352-1357 (the x_col / pairs split).
  const drill = useMemo<{
    resp: Schemas["TopNResponse"];
    facetBy: "binding" | "perturbation";
  } | null>(() => {
    if (!cdResponse) return null;
    const { binding: selB, perturbation: selP } = selection;
    if (selB === null && selP === null) return null;
    const rows = (cdResponse.rows ?? []).filter((r) => {
      const sep = r.pairKey.indexOf("__");
      if (sep < 0) return false;
      const bDb = r.pairKey.slice(0, sep);
      const pDb = r.pairKey.slice(sep + 2);
      return selB !== null ? bDb === selB : pDb === selP;
    });
    return {
      resp: { ...cdResponse, rows },
      // A selected binding row varies over perturbations → facet by binding.
      // A selected perturbation column varies over bindings → facet by perturbation.
      facetBy: selB !== null ? "binding" : "perturbation",
    };
  }, [cdResponse, selection]);

  const bothPicked = binding.length > 0 && perturbation.length > 0;

  return (
    <section className="grid grid-cols-[260px_1fr] gap-4">
      <ComparisonSidebar
        topN={topN}
        preset={preset}
        onChange={handleSidebarChange}
      />
      <div className="space-y-4">
        {/* C-8 / HOME-1: page heading matches Shiny nav panel label (app.py:75-79). */}
        <h1 className="text-2xl font-semibold">
          Binding/Perturbation Comparisons
        </h1>

        {/* Explanatory bullets mirror ui.py:61-89. */}
        <div className="text-sm text-slate-600">
          <p>
            Compare selected binding and perturbation datasets. Values are median
            percent-responsive across regulators.
          </p>
          <ul className="ml-5 mt-2 list-disc space-y-1">
            <li>
              <strong>Compare Datasets:</strong> binding vs. perturbation matrix.
              Each cell shows the median percent of top-N binding targets that
              are transcriptionally responsive. Click row/column headers to view
              distributions.
            </li>
            <li>
              <strong>Compare Promoter Definitions:</strong> side-by-side tables
              comparing promoter enrichment scores across promoter sets.
            </li>
            <li>
              <strong>Compare Analysis Methods:</strong> side-by-side tables
              comparing promoter enrichment vs. original peaks scoring.
            </li>
          </ul>
        </div>

        <ErrorBoundary>
          {!bothPicked ? (
            <p className="text-sm text-slate-600">
              Pick at least one binding and one perturbation dataset on the
              Select page to render the Top-N comparison.
            </p>
          ) : null}
          {topnQuery.error ? (
            <p className="text-red-600">{apiErrorMessage(topnQuery.error)}</p>
          ) : null}

          {bothPicked ? (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="datasets">Compare Datasets</TabsTrigger>
                <TabsTrigger value="promoters">
                  Compare Promoter Definitions
                </TabsTrigger>
                <TabsTrigger value="methods">
                  Compare Analysis Methods
                </TabsTrigger>
              </TabsList>

              {/* --- Compare Datasets tab --- */}
              <TabsContent value="datasets">
                <CompareDatasetsControls
                  method={cdMethod}
                  promoterSet={cdPromoterSet}
                  onMethodChange={setCdMethod}
                  onPromoterSetChange={setCdPromoterSet}
                />
                {cdRowPrimaries.length === 0 ? (
                  <p className="text-sm text-slate-600">
                    {cdMethod === "Peaks"
                      ? "None of the selected binding datasets have original peaks calls (only the ChIP-exo and ChEC-seq datasets do). Switch Binding Method back to Promoter Enrichment, or select one of those datasets."
                      : "Select at least one primary binding dataset to see the comparison matrix."}
                  </p>
                ) : topnQuery.isPending ? (
                  <ComparisonBoxplotSkeleton />
                ) : cdResponse ? (
                  <div className="space-y-6">
                    <TopNMatrix
                      resp={cdResponse}
                      bindingDatasets={cdRowPrimaries}
                      perturbationDatasets={perturbation}
                      displayName={displayName}
                      selection={selection}
                      onSelectBinding={(db) =>
                        setSelection({ binding: db, perturbation: null })
                      }
                      onSelectPerturbation={(db) =>
                        setSelection({ binding: null, perturbation: db })
                      }
                    />
                    {/* Drill-down distribution for the selected row/column. */}
                    {drill ? (
                      <ComparisonBoxplot
                        resp={drill.resp}
                        facetBy={drill.facetBy}
                      />
                    ) : (
                      <p className="text-sm text-slate-600">
                        Click a row header to view distributions for a binding
                        dataset, or a column header to view distributions for a
                        perturbation dataset.
                      </p>
                    )}
                  </div>
                ) : null}
              </TabsContent>

              {/* --- Compare Promoter Definitions tab --- */}
              <TabsContent value="promoters">
                <PromoterSetSelector
                  selected={selectedPromoterSets}
                  onChange={setPromoterSets}
                />
                <PromoterDefinitionsTable
                  bindingPrimaries={bindingPrimaries}
                  perturbationDatasets={perturbation}
                  selectedPromoterSets={selectedPromoterSets}
                  topN={topN}
                  preset={preset}
                  filters={filters}
                />
              </TabsContent>

              {/* --- Compare Analysis Methods tab --- */}
              <TabsContent value="methods">
                <AnalysisMethodsTable
                  bindingPrimaries={bindingPrimaries}
                  perturbationDatasets={perturbation}
                  topN={topN}
                  preset={preset}
                  filters={filters}
                />
              </TabsContent>
            </Tabs>
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
