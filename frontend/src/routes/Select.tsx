// Select Datasets — Task B4 of the Phase A overnight rebuild.
//
// Implements the P0 subset of docs/parity/select_datasets.md §2:
//   row 5  per-row Filter button → DatasetFilterModal
//   row 25 per-row active-filter badge
//   row 26/27 intersection matrix workspace (SelectionMatrix)
//   row 29 off-diagonal click → CommonRegulatorsModal
//
// Deferred to docs/parity/auto-status/polish.md (see end of this commit):
//   - row 3/4   default-active datasets / default filters
//   - row 12/14 apply-to-all toggle
//   - row 15/30/31 from_pair annotation + highlight
//   - row 16    sidebar search box (P2)
//   - row 18/20 staged Apply gate at page level — we use the simpler MVP
//               where each modal's own "Apply Filters" button writes to
//               the URL directly. This matches Phase 2's checkbox-toggles-
//               write-URL pattern and audit §8 already flagged the
//               staging question as UNCLEAR.
//   - row 22    description tooltip on row
//   - row 23    sidebar collapse/expand
//   - row 28    diagonal click → /selection/breakdown modal
//   - row 35/36 CSV+README export
//
// URL contract:
//   ?binding=A,B         CSV of active binding db_names
//   ?perturbation=C,D    CSV of active perturbation db_names
//   ?filters=<json>      FiltersByDB-shape JSON (URL-encoded)
//   ?regulators=A,B,C    optional CSV, written by CommonRegulatorsModal

import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Schemas } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { DatasetFilterModal } from "@/components/DatasetFilterModal";
import { CommonRegulatorsModal } from "@/components/CommonRegulatorsModal";
import { SelectionMatrix } from "@/plots/SelectionMatrix";

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

  const selectedBinding = useMemo(() => parseCsv(params.get("binding")), [params]);
  const selectedPerturbation = useMemo(
    () => parseCsv(params.get("perturbation")),
    [params],
  );
  const filters = useMemo(() => parseFiltersFromURL(params.get("filters")), [params]);
  const filtersRaw = params.get("filters") ?? "";

  // Modal state — pending filter target (which dataset's modal is open).
  const [filterDb, setFilterDb] = useState<string | null>(null);
  // Modal state — common-regulators target (which pair was clicked).
  const [commonPair, setCommonPair] = useState<[string, string] | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: qk.datasets(),
    queryFn: () => api.datasets(),
  });

  const datasets = data?.datasets ?? [];
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

  // Active matrix = union of binding + perturbation selections in stable order.
  // Sort here so the matrix table renders deterministically; the backend also
  // sorts internally for cross-pair computation.
  const matrixDatasets = useMemo(
    () => [...selectedBinding, ...selectedPerturbation].sort(),
    [selectedBinding, selectedPerturbation],
  );

  const onToggle = useCallback(
    (paramKey: "binding" | "perturbation", dbName: string, checked: boolean): void => {
      const current = paramKey === "binding" ? selectedBinding : selectedPerturbation;
      const next = toggleMembership(current, dbName, checked);
      const nextParams = new URLSearchParams(params);
      if (next.length === 0) nextParams.delete(paramKey);
      else nextParams.set(paramKey, next.join(","));
      // Row 38: toggling off a dataset clears its filter block. Mirrors
      // Shiny dataset_row.py:152-165.
      if (!checked && filters[dbName]) {
        const nextFilters = { ...filters };
        delete nextFilters[dbName];
        if (Object.keys(nextFilters).length === 0) nextParams.delete("filters");
        else nextParams.set("filters", serializeFiltersToURL(nextFilters));
      }
      setParams(nextParams, { replace: false });
    },
    [params, selectedBinding, selectedPerturbation, filters, setParams],
  );

  const onApplyFilters = useCallback(
    (db: string, next: Record<string, FilterSpec>): void => {
      const merged: FiltersByDB = { ...filters };
      if (Object.keys(next).length === 0) delete merged[db];
      else merged[db] = next;
      const nextParams = new URLSearchParams(params);
      if (Object.keys(merged).length === 0) nextParams.delete("filters");
      else nextParams.set("filters", serializeFiltersToURL(merged));
      setParams(nextParams, { replace: false });
      setFilterDb(null);
    },
    [params, filters, setParams],
  );

  const onSelectCommon = useCallback(
    (tags: string[]): void => {
      const nextParams = new URLSearchParams(params);
      if (tags.length === 0) nextParams.delete("regulators");
      else nextParams.set("regulators", tags.join(","));
      setParams(nextParams, { replace: false });
    },
    [params, setParams],
  );

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

      <div className="grid gap-6 md:grid-cols-[300px_1fr]">
        <aside className="space-y-6">
          <h2 className="text-lg font-semibold">Datasets</h2>
          <DatasetSection
            title="Binding"
            datasets={binding}
            selected={selectedBinding}
            filters={filters}
            onToggle={(db, c) => onToggle("binding", db, c)}
            onOpenFilter={(db) => setFilterDb(db)}
          />
          <DatasetSection
            title="Perturbation"
            datasets={perturbation}
            selected={selectedPerturbation}
            filters={filters}
            onToggle={(db, c) => onToggle("perturbation", db, c)}
            onOpenFilter={(db) => setFilterDb(db)}
          />
        </aside>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Selection Matrix</h2>
          <SelectionMatrix
            datasets={matrixDatasets}
            filters={filtersRaw}
            datasetDisplay={displayName}
            onOffDiagonalClick={(a, b) => setCommonPair([a, b])}
          />
        </section>
      </div>

      <DatasetFilterModal
        open={filterDb !== null}
        onClose={() => setFilterDb(null)}
        db={filterDb ?? ""}
        displayName={filterDb ? displayName(filterDb) : ""}
        currentFilters={filterDb ? filters[filterDb] ?? null : null}
        onApply={(next) => filterDb && onApplyFilters(filterDb, next)}
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
