// Select Datasets — Task B4 of the Phase A overnight rebuild.
//
// Implements the P0 subset of docs/parity/select_datasets.md §2:
//   row 5  per-row Filter button → DatasetFilterModal
//   row 25 per-row active-filter badge
//   row 26/27 intersection matrix workspace (SelectionMatrix)
//   row 29 off-diagonal click → CommonRegulatorsModal
//
// Task C4 (schema_version=4 metadata) adds:
//   row 1   sort datasets by display_name (client-side)
//   row 3   default-active datasets on first visit (URL preselection)
//   row 4   default filters on first visit
//   row 28  diagonal click → DatasetBreakdownModal
//
// Task C5 closes the remaining UX gaps from docs/parity/select_datasets.md §2:
//   rows 12, 14 apply-to-all toggle on common fields in the filter modal
//   rows 15, 30, 31 from_pair annotation + matrix highlight + click-to-clear
//   rows 18, 20, 21 staged Apply gate for dataset checkbox toggles
//                   (filter modal still writes URL directly — smallest
//                    blast radius per audit §8 / task spec)
//   row 23 sidebar collapse/expand (persisted via ?selectSidebar=)
//   row 24 sidebar search box (with "No datasets match..." empty state, row 34)
//
// Task C6 closes the export gap:
//   row 35 per-dataset CSV+README export bundled as .tar.gz
//   row 36 "Export Selected Datasets" footer button, visible when ≥1 selected
//
// URL contract:
//   ?binding=A,B              CSV of active binding db_names (committed)
//   ?perturbation=C,D         CSV of active perturbation db_names (committed)
//   ?filters=<json>           FiltersByDB-shape JSON (URL-encoded)
//                             — values may include a frontend-only
//                             `fromPair` annotation; see lib/filter-spec.ts.
//   ?regulators=A,B,C         optional CSV (legacy; Phase B side-channel)
//   ?selectSidebar=collapsed  optional sidebar state, default open

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api, type Schemas } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { DatasetFilterModal } from "@/components/DatasetFilterModal";
import { CommonRegulatorsModal } from "@/components/CommonRegulatorsModal";
import { DatasetBreakdownModal } from "@/components/DatasetBreakdownModal";
import { SelectionMatrix } from "@/plots/SelectionMatrix";
import {
  REGULATOR_LOCUS_TAG_FIELD,
  buildFromPairFilter,
  readFromPair,
} from "@/lib/filter-spec";

type DatasetEntry = Schemas["DatasetEntry"];
type FilterSpec = Schemas["FilterSpec"];
type FiltersByDB = Record<string, Record<string, FilterSpec>>;

function parseCsv(value: string | null): string[] {
  return (value ?? "").split(",").filter(Boolean);
}

function toggleMembership(list: string[], item: string, checked: boolean): string[] {
  const set = new Set(list);
  if (checked) set.add(item);
  else set.delete(item);
  return [...set];
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

/**
 * Parse the URL `?filters=` JSON safely. Returns an empty object on any
 * decode/JSON error — the user can't fix a malformed URL by retrying, so
 * silent-empty matches the principle of least astonishment here.
 */
function parseFiltersFromURL(raw: string | null): FiltersByDB {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as FiltersByDB;
  } catch {
    // fall through
  }
  return {};
}

function serializeFiltersToURL(filters: FiltersByDB): string {
  return JSON.stringify(filters);
}

export function Select() {
  const [params, setParams] = useSearchParams();

  // Committed selection — what's in URL right now.
  const committedBinding = useMemo(() => parseCsv(params.get("binding")), [params]);
  const committedPerturbation = useMemo(
    () => parseCsv(params.get("perturbation")),
    [params],
  );
  const filters = useMemo(() => parseFiltersFromURL(params.get("filters")), [params]);
  const filtersRaw = params.get("filters") ?? "";
  const sidebarCollapsed = params.get("selectSidebar") === "collapsed";

  // C5: staged-Apply gate state. Dataset checkbox toggles update these
  // pending lists; the page-footer "Apply" button commits them to URL.
  // Initialized from URL, then resynced when the URL changes (e.g.
  // back/forward navigation).
  const [pendingBinding, setPendingBinding] = useState<string[]>(committedBinding);
  const [pendingPerturbation, setPendingPerturbation] = useState<string[]>(
    committedPerturbation,
  );
  // Track the URL token we last synced from so external URL changes
  // refresh pending state but our own optimistic updates don't trigger
  // a re-sync race. Compare on the URL-rendered CSV strings.
  const lastSyncedRef = useRef<{ b: string; p: string }>({
    b: committedBinding.join(","),
    p: committedPerturbation.join(","),
  });
  useEffect(() => {
    const b = committedBinding.join(",");
    const p = committedPerturbation.join(",");
    if (lastSyncedRef.current.b !== b || lastSyncedRef.current.p !== p) {
      lastSyncedRef.current = { b, p };
      setPendingBinding(committedBinding);
      setPendingPerturbation(committedPerturbation);
    }
  }, [committedBinding, committedPerturbation]);

  // Sidebar search box (C5 row 24). Local state only — not URL — because
  // it's purely a UI affordance for navigating the dataset list.
  const [search, setSearch] = useState("");

  // Modal state — pending filter target (which dataset's modal is open).
  const [filterDb, setFilterDb] = useState<string | null>(null);
  // Modal state — common-regulators target (which pair was clicked).
  const [commonPair, setCommonPair] = useState<[string, string] | null>(null);
  // Modal state — breakdown target (which diagonal cell was clicked, C4).
  const [breakdownDb, setBreakdownDb] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: qk.datasets(),
    queryFn: () => api.datasets(),
  });

  // C4 (audit row 1): sort client-side by displayName so the sidebar follows
  // human-readable order without forcing a backend re-snapshot. Backend
  // still orders by db_name internally (stable for cross-pair computation).
  const datasets = useMemo(
    () =>
      [...(data?.datasets ?? [])].sort((a, b) =>
        a.displayName.localeCompare(b.displayName),
      ),
    [data],
  );
  const binding = datasets.filter((d) => d.dataType === "binding");
  const perturbation = datasets.filter((d) => d.dataType === "perturbation");
  const displayNameByDb = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of datasets) m.set(d.dbName, d.displayName);
    return m;
  }, [datasets]);
  const displayName = useCallback(
    (db: string): string => displayNameByDb.get(db) ?? db,
    [displayNameByDb],
  );

  // Active matrix = union of committed binding + perturbation selections in
  // stable order. The matrix renders against committed state, NOT pending —
  // staged checkbox flips are invisible until Apply.
  const matrixDatasets = useMemo(
    () => [...committedBinding, ...committedPerturbation].sort(),
    [committedBinding, committedPerturbation],
  );

  // C5 (rows 12, 14): fetch /datasets/{db}/fields for every committed-active
  // dataset so we can compute the "common fields" set the filter modal uses
  // to gate its "Apply to all datasets" toggle.
  const activeDbs = matrixDatasets;
  const fieldQueries = useQueries({
    queries: activeDbs.map((db) => ({
      queryKey: qk.datasetFields(db),
      queryFn: () => api.datasetFields({ db }),
    })),
  });
  /**
   * Map db_name → Set<field name>. Only datasets whose query has resolved
   * are included; that's fine for the intersection because a missing
   * dataset means we don't yet know its fields, and we'd rather show "no
   * common fields" than incorrectly include a field that turns out to be
   * absent from one of the slow loaders.
   */
  const fieldsByDb = useMemo<Map<string, Set<string>>>(() => {
    const m = new Map<string, Set<string>>();
    activeDbs.forEach((db, i) => {
      const d = fieldQueries[i]?.data;
      // Defensive: in tests + edge cases the mock may resolve before
      // sending the typed body, so guard against missing `fields`.
      if (d && Array.isArray(d.fields))
        m.set(db, new Set(d.fields.map((f) => f.field)));
    });
    return m;
  }, [activeDbs, fieldQueries]);
  /** Intersection of `fieldsByDb` values. Empty when only one dataset is active. */
  const commonFields = useMemo<Set<string>>(() => {
    if (fieldsByDb.size < 2) return new Set();
    const sets = [...fieldsByDb.values()];
    const first = sets[0];
    if (!first) return new Set();
    // Iterate via array snapshot so mutation during iteration is safe.
    const out = new Set<string>();
    for (const f of first) {
      if (sets.every((s) => s.has(f))) out.add(f);
    }
    return out;
  }, [fieldsByDb]);

  // Toggle a dataset checkbox — updates *pending* state only. URL is
  // untouched until the user clicks the page-footer Apply button.
  const onToggle = useCallback(
    (paramKey: "binding" | "perturbation", dbName: string, checked: boolean): void => {
      if (paramKey === "binding") {
        setPendingBinding((cur) => toggleMembership(cur, dbName, checked));
      } else {
        setPendingPerturbation((cur) => toggleMembership(cur, dbName, checked));
      }
    },
    [],
  );

  // C5: commit pending selection → URL. Also handles the row-38 contract:
  // toggling off a dataset clears its filter block (mirrors Shiny
  // dataset_row.py:152-165).
  const onCommitStaged = useCallback((): void => {
    const nextParams = new URLSearchParams(params);
    if (pendingBinding.length === 0) nextParams.delete("binding");
    else nextParams.set("binding", [...pendingBinding].sort().join(","));
    if (pendingPerturbation.length === 0) nextParams.delete("perturbation");
    else nextParams.set("perturbation", [...pendingPerturbation].sort().join(","));

    // Drop filter blocks for any dataset that was removed.
    const stillActive = new Set([...pendingBinding, ...pendingPerturbation]);
    let nextFilters: FiltersByDB | null = null;
    for (const db of Object.keys(filters)) {
      if (!stillActive.has(db)) {
        if (nextFilters === null) nextFilters = { ...filters };
        delete nextFilters[db];
      }
    }
    if (nextFilters !== null) {
      if (Object.keys(nextFilters).length === 0) nextParams.delete("filters");
      else nextParams.set("filters", serializeFiltersToURL(nextFilters));
    }
    setParams(nextParams, { replace: false });
  }, [params, pendingBinding, pendingPerturbation, filters, setParams]);

  const onResetStaged = useCallback((): void => {
    setPendingBinding(committedBinding);
    setPendingPerturbation(committedPerturbation);
  }, [committedBinding, committedPerturbation]);

  const stagedDirty =
    !sameSet(pendingBinding, committedBinding) ||
    !sameSet(pendingPerturbation, committedPerturbation);

  // Apply Filters from DatasetFilterModal — writes URL directly (separate
  // gate from the dataset-checkbox stage; see header comment + task spec).
  const onApplyFilters = useCallback(
    (
      db: string,
      next: Record<string, FilterSpec>,
      applyToAllFields: string[],
    ): void => {
      const merged: FiltersByDB = { ...filters };
      // Apply to the current dataset.
      if (Object.keys(next).length === 0) delete merged[db];
      else merged[db] = next;

      // C5 rows 12/14: mirror flagged fields into every other active
      // dataset that has the field in its manifest.
      if (applyToAllFields.length > 0) {
        const other = [...committedBinding, ...committedPerturbation].filter(
          (x) => x !== db,
        );
        for (const otherDb of other) {
          const otherFields = fieldsByDb.get(otherDb);
          if (!otherFields) continue;
          for (const f of applyToAllFields) {
            if (!otherFields.has(f)) continue;
            const spec = next[f];
            const block = { ...(merged[otherDb] ?? {}) };
            if (spec) block[f] = spec;
            else delete block[f];
            if (Object.keys(block).length === 0) delete merged[otherDb];
            else merged[otherDb] = block;
          }
        }
      }

      const nextParams = new URLSearchParams(params);
      if (Object.keys(merged).length === 0) nextParams.delete("filters");
      else nextParams.set("filters", serializeFiltersToURL(merged));
      setParams(nextParams, { replace: false });
      setFilterDb(null);
    },
    [params, filters, committedBinding, committedPerturbation, fieldsByDb, setParams],
  );

  // C4 (audit rows 3 + 4): first-visit defaults. When the user lands with no
  // ?binding=, ?perturbation=, or ?filters= query params AND the /datasets
  // response has arrived, preselect every dataset whose manifest entry has
  // `defaultActive=true` and seed `?filters=` from each dataset's
  // `defaultFilters` (JSON object, may be null). One-shot per mount via
  // useRef so navigating back to /select after intentional deselect does
  // NOT re-add the defaults.
  const defaultsAppliedRef = useRef(false);
  useEffect(() => {
    if (defaultsAppliedRef.current) return;
    if (!data) return;
    const hasBinding = (params.get("binding") ?? "") !== "";
    const hasPerturbation = (params.get("perturbation") ?? "") !== "";
    const hasFilters = (params.get("filters") ?? "") !== "";
    if (hasBinding || hasPerturbation) {
      // User arrived with explicit selection (e.g. shared link) — never
      // overwrite. Mark applied so we don't retry on subsequent renders.
      defaultsAppliedRef.current = true;
      return;
    }
    const defaultActive = datasets.filter((d) => d.defaultActive === true);
    if (defaultActive.length === 0) {
      defaultsAppliedRef.current = true;
      return;
    }
    const defaultBinding = defaultActive
      .filter((d) => d.dataType === "binding")
      .map((d) => d.dbName);
    const defaultPerturbation = defaultActive
      .filter((d) => d.dataType === "perturbation")
      .map((d) => d.dbName);
    const next = new URLSearchParams(params);
    if (defaultBinding.length > 0) next.set("binding", defaultBinding.join(","));
    if (defaultPerturbation.length > 0)
      next.set("perturbation", defaultPerturbation.join(","));
    // Seed `?filters=` only when the URL didn't already carry one.
    if (!hasFilters) {
      const merged: FiltersByDB = {};
      for (const d of defaultActive) {
        const df = d.defaultFilters;
        if (df && typeof df === "object" && Object.keys(df).length > 0) {
          merged[d.dbName] = df as Record<string, FilterSpec>;
        }
      }
      if (Object.keys(merged).length > 0) {
        next.set("filters", serializeFiltersToURL(merged));
      }
    }
    defaultsAppliedRef.current = true;
    // replace:true so the back button doesn't bounce to an empty URL.
    setParams(next, { replace: true });
  }, [data, datasets, params, setParams]);

  // C5 (rows 15, 30, 31): when the user picks "Select N common regulators"
  // in the off-diagonal modal, write the resulting regulator_locus_tag
  // filter to every active dataset that has the field, tagged with the
  // originating display-name pair. Also retain ?regulators= for the
  // legacy Phase B side-channel so downstream views keep working.
  const onSelectCommon = useCallback(
    (tags: string[], pair: [string, string]): void => {
      const nextParams = new URLSearchParams(params);
      if (tags.length === 0) nextParams.delete("regulators");
      else nextParams.set("regulators", tags.join(","));

      const annotated = buildFromPairFilter(tags, pair);
      const merged: FiltersByDB = { ...filters };
      let touched = false;
      for (const db of [...committedBinding, ...committedPerturbation]) {
        const fset = fieldsByDb.get(db);
        // If we don't yet know the field set (query pending), still apply
        // — the safest assumption is that regulator_locus_tag exists on
        // every dataset (it's how every dataset keys its meta rows).
        if (fset && !fset.has(REGULATOR_LOCUS_TAG_FIELD)) continue;
        const block = { ...(merged[db] ?? {}) };
        block[REGULATOR_LOCUS_TAG_FIELD] = annotated;
        merged[db] = block;
        touched = true;
      }
      if (touched) {
        if (Object.keys(merged).length === 0) nextParams.delete("filters");
        else nextParams.set("filters", serializeFiltersToURL(merged));
      }
      setParams(nextParams, { replace: false });
    },
    [params, filters, committedBinding, committedPerturbation, fieldsByDb, setParams],
  );

  // C5 (row 31): clear all from_pair regulator_locus_tag filters and the
  // ?regulators= side-channel.
  const onClearFromPair = useCallback((): void => {
    const merged: FiltersByDB = { ...filters };
    let touched = false;
    for (const db of Object.keys(merged)) {
      const block = { ...(merged[db] ?? {}) };
      const spec = block[REGULATOR_LOCUS_TAG_FIELD];
      if (spec && readFromPair(spec)) {
        delete block[REGULATOR_LOCUS_TAG_FIELD];
        if (Object.keys(block).length === 0) delete merged[db];
        else merged[db] = block;
        touched = true;
      }
    }
    const nextParams = new URLSearchParams(params);
    if (touched) {
      if (Object.keys(merged).length === 0) nextParams.delete("filters");
      else nextParams.set("filters", serializeFiltersToURL(merged));
    }
    nextParams.delete("regulators");
    setParams(nextParams, { replace: false });
  }, [params, filters, setParams]);

  // Detect the active from_pair (if any) for matrix highlighting. We pick
  // the first pair we find — there's only ever one in practice because
  // onSelectCommon writes the same annotation to every dataset.
  const activeFromPair = useMemo<[string, string] | null>(() => {
    for (const db of Object.keys(filters)) {
      const spec = filters[db]?.[REGULATOR_LOCUS_TAG_FIELD];
      const fp = readFromPair(spec);
      if (fp) {
        // Translate display names back to db_names so the matrix can
        // match against its rowDb/colDb keys.
        const dbA = [...displayNameByDb.entries()].find(([, dn]) => dn === fp[0])?.[0];
        const dbB = [...displayNameByDb.entries()].find(([, dn]) => dn === fp[1])?.[0];
        if (dbA && dbB) {
          return dbA <= dbB ? [dbA, dbB] : [dbB, dbA];
        }
        return null;
      }
    }
    return null;
  }, [filters, displayNameByDb]);

  const onToggleSidebar = useCallback((): void => {
    const next = new URLSearchParams(params);
    if (sidebarCollapsed) next.delete("selectSidebar");
    else next.set("selectSidebar", "collapsed");
    setParams(next, { replace: false });
  }, [params, sidebarCollapsed, setParams]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Select Datasets</h1>
        <div className="grid grid-cols-[300px_1fr] gap-6">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Select Datasets</h1>
        <p className="text-sm text-red-700">
          Failed to load datasets: {error instanceof Error ? error.message : "unknown error"}
        </p>
      </div>
    );
  }

  // Client-side search filter (C5 row 24). Empty query keeps everything.
  const q = search.trim().toLowerCase();
  const matches = (d: DatasetEntry): boolean =>
    q === "" || d.displayName.toLowerCase().includes(q);
  const bindingFiltered = binding.filter(matches);
  const perturbationFiltered = perturbation.filter(matches);
  const totalMatched = bindingFiltered.length + perturbationFiltered.length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Select Datasets</h1>
        <p className="mt-1 text-sm text-slate-600">
          Toggle datasets and apply per-row filters. Selection and filters are
          stored in the URL and shared with the Binding, Perturbation, and
          Comparison views.
        </p>
      </header>

      <div
        className={
          sidebarCollapsed
            ? "grid gap-6 md:grid-cols-[40px_1fr]"
            : "grid gap-6 md:grid-cols-[300px_1fr]"
        }
      >
        <aside className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            {!sidebarCollapsed && <h2 className="text-lg font-semibold">Datasets</h2>}
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              data-testid="sidebar-toggle"
              className="rounded border border-slate-200 px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
            >
              {sidebarCollapsed ? "›" : "‹"}
            </button>
          </div>

          {!sidebarCollapsed && (
            <>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                placeholder="Search datasets..."
                aria-label="Search datasets"
                data-testid="sidebar-search"
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
              />
              {q !== "" && totalMatched === 0 ? (
                <p
                  className="text-xs text-slate-500"
                  data-testid="sidebar-empty"
                >
                  No datasets match your search.
                </p>
              ) : (
                <>
                  <DatasetSection
                    title="Binding"
                    datasets={bindingFiltered}
                    selected={pendingBinding}
                    filters={filters}
                    onToggle={(db, c) => onToggle("binding", db, c)}
                    onOpenFilter={(db) => setFilterDb(db)}
                  />
                  <DatasetSection
                    title="Perturbation"
                    datasets={perturbationFiltered}
                    selected={pendingPerturbation}
                    filters={filters}
                    onToggle={(db, c) => onToggle("perturbation", db, c)}
                    onOpenFilter={(db) => setFilterDb(db)}
                  />
                </>
              )}
              <ExportSelectedButton
                binding={committedBinding}
                perturbation={committedPerturbation}
                filtersRaw={filtersRaw}
              />
            </>
          )}
        </aside>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Selection Matrix</h2>
          <SelectionMatrix
            datasets={matrixDatasets}
            filters={filtersRaw}
            datasetDisplay={displayName}
            onOffDiagonalClick={(a, b) => setCommonPair([a, b])}
            onDiagonalClick={(db) => setBreakdownDb(db)}
            highlightedPair={activeFromPair}
            onHighlightedClear={onClearFromPair}
          />
        </section>
      </div>

      {/* C5 (rows 18, 20, 21): page-footer staged Apply gate. Only visible
          when pending differs from committed. */}
      {stagedDirty && (
        <footer
          className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur"
          data-testid="staged-apply-footer"
        >
          <p className="mr-auto text-xs text-slate-600">
            You have unsaved dataset selection changes.
          </p>
          <Button onClick={onResetStaged} data-testid="staged-reset">
            Reset
          </Button>
          <Button
            onClick={onCommitStaged}
            data-testid="staged-apply"
            className="border-blue-600 bg-blue-600 text-white hover:bg-blue-700"
          >
            Apply
          </Button>
        </footer>
      )}

      <DatasetFilterModal
        open={filterDb !== null}
        onClose={() => setFilterDb(null)}
        db={filterDb ?? ""}
        displayName={filterDb ? displayName(filterDb) : ""}
        currentFilters={filterDb ? filters[filterDb] ?? null : null}
        commonFields={commonFields}
        onApply={({ next, applyToAllFields }) =>
          filterDb && onApplyFilters(filterDb, next, applyToAllFields)
        }
      />

      <CommonRegulatorsModal
        open={commonPair !== null}
        onClose={() => setCommonPair(null)}
        dbA={commonPair?.[0] ?? ""}
        dbB={commonPair?.[1] ?? ""}
        displayA={commonPair ? displayName(commonPair[0]) : ""}
        displayB={commonPair ? displayName(commonPair[1]) : ""}
        onSelectCommon={onSelectCommon}
      />

      <DatasetBreakdownModal
        open={breakdownDb !== null}
        onClose={() => setBreakdownDb(null)}
        db={breakdownDb ?? ""}
        displayName={breakdownDb ? displayName(breakdownDb) : ""}
        filters={filtersRaw}
      />
    </div>
  );
}

interface DatasetSectionProps {
  title: string;
  datasets: DatasetEntry[];
  selected: string[];
  filters: FiltersByDB;
  onToggle: (db: string, checked: boolean) => void;
  onOpenFilter: (db: string) => void;
}

function DatasetSection({
  title,
  datasets,
  selected,
  filters,
  onToggle,
  onOpenFilter,
}: DatasetSectionProps) {
  if (datasets.length === 0) {
    return (
      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-700">{title}</h3>
        <p className="text-xs text-slate-500">No {title.toLowerCase()} datasets available.</p>
      </section>
    );
  }
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-slate-700">{title}</h3>
      <ul className="space-y-1">
        {datasets.map((d) => {
          const checked = selected.includes(d.dbName);
          const block = filters[d.dbName];
          const activeCount = block ? Object.keys(block).length : 0;
          const id = `ds-${d.dbName}`;
          return (
            <li key={d.dbName} className="flex items-center gap-2">
              <label htmlFor={id} className="flex flex-1 cursor-pointer items-center gap-2">
                <Checkbox
                  id={id}
                  checked={checked}
                  onChange={(e) => onToggle(d.dbName, e.currentTarget.checked)}
                />
                <span className="text-sm">{d.displayName}</span>
              </label>
              {activeCount > 0 && (
                <span
                  className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                  data-testid={`badge-${d.dbName}`}
                  title={`${activeCount} active filter${activeCount === 1 ? "" : "s"}`}
                >
                  {activeCount}
                </span>
              )}
              <Button size="sm" onClick={() => onOpenFilter(d.dbName)}>
                Filter
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface ExportSelectedButtonProps {
  binding: string[];
  perturbation: string[];
  filtersRaw: string;
}

/**
 * Sidebar-footer "Export Selected Datasets" button (audit row 36).
 *
 * Visible only when ≥1 dataset is in the **committed** selection (URL),
 * because the export endpoint reads the same params the URL carries.
 * Staged-but-uncommitted selections deliberately don't drive the button
 * — exporting datasets the user hasn't actually committed would be
 * surprising.
 *
 * Click triggers a top-level navigation (`window.location.href = url`)
 * so the browser handles the binary tar.gz stream natively; the
 * response never lands in JS memory and the user gets the OS File Save
 * dialog. This is the documented pattern in `api.exportUrl`.
 */
function ExportSelectedButton({
  binding,
  perturbation,
  filtersRaw,
}: ExportSelectedButtonProps) {
  const all = [...binding, ...perturbation];
  if (all.length === 0) return null;
  const onClick = (): void => {
    const url = filtersRaw
      ? api.exportUrl({ datasets: all, filters: filtersRaw })
      : api.exportUrl({ datasets: all });
    // Top-level navigation so the browser owns the binary stream.
    // We use assign() (not href setter) for testability — vitest's
    // jsdom mocks window.location.assign cleanly.
    window.location.assign(url);
  };
  return (
    <div className="border-t border-slate-200 pt-3">
      <Button
        type="button"
        size="sm"
        onClick={onClick}
        data-testid="export-selected"
        className="w-full"
      >
        Export Selected Datasets ({all.length})
      </Button>
      <p className="mt-1 text-xs text-slate-500">
        Downloads a .tar.gz with metadata, features, and README per dataset.
      </p>
    </div>
  );
}
