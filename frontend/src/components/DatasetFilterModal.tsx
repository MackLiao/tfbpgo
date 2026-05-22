// Per-dataset filter modal — Task B4 of the Phase A overnight rebuild.
//
// Scope mirrors P0 rows of docs/parity/select_datasets.md §2:
//  - row 5  per-row Filter button opens this modal
//  - row 7  categorical fields render as multi-select (checkbox list)
//  - row 8  numeric fields render as a two-handle range
//  - row 9  bool fields render as a checkbox
//  - row 16 Reset / Apply Filters buttons in the modal footer
//
// Deferred (see polish.md): "Apply to all datasets" toggle (row 12),
// description tooltip (row 9 label), level_definitions checkboxes (row 10),
// cascade narrowing (row 19), from_pair annotation (rows 15/30/31).
//
// State model: this component holds a `pending` map locally and commits it
// to URL via `onApply` only when the user clicks "Apply Filters". The page
// owns the URL `?filters=` writeback; we just hand back the next per-field
// FilterSpec map for this dataset.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Schemas } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";

type FilterSpec = Schemas["FilterSpec"];
type FieldMeta = Schemas["FieldMeta"];

export interface DatasetFilterModalProps {
  open: boolean;
  onClose: () => void;
  db: string;
  displayName: string;
  /** The current (committed) filters for this dataset; null = no filters set. */
  currentFilters: Record<string, FilterSpec> | null;
  onApply: (next: Record<string, FilterSpec>) => void;
}

export function DatasetFilterModal(props: DatasetFilterModalProps) {
  const { open, onClose, db, displayName, currentFilters, onApply } = props;
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // Sync the <dialog>'s native modal state with the `open` prop.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onCancel={onClose}
      className="w-[min(720px,90vw)] max-w-none rounded-lg p-0 backdrop:bg-slate-900/50"
    >
      {/* Only mount the inner body when open, so each open is a fresh
          pending-state cycle and the /datasets/{db}/fields query doesn't
          fire for closed modals. */}
      {open && (
        <ModalBody
          db={db}
          displayName={displayName}
          currentFilters={currentFilters}
          onApply={onApply}
          onClose={onClose}
        />
      )}
    </dialog>
  );
}

interface ModalBodyProps {
  db: string;
  displayName: string;
  currentFilters: Record<string, FilterSpec> | null;
  onApply: (next: Record<string, FilterSpec>) => void;
  onClose: () => void;
}

function ModalBody({ db, displayName, currentFilters, onApply, onClose }: ModalBodyProps) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: qk.datasetFields(db),
    queryFn: () => api.datasetFields({ db }),
  });

  const initial = useMemo<Record<string, FilterSpec>>(
    () => ({ ...(currentFilters ?? {}) }),
    [currentFilters],
  );
  const [pending, setPending] = useState<Record<string, FilterSpec>>(initial);

  // If the parent flips currentFilters mid-modal (e.g. URL changed externally),
  // rehydrate pending from it.
  useEffect(() => {
    setPending({ ...(currentFilters ?? {}) });
  }, [currentFilters]);

  const setSpec = (field: string, spec: FilterSpec | null): void => {
    setPending((prev) => {
      const next = { ...prev };
      if (spec === null) delete next[field];
      else next[field] = spec;
      return next;
    });
  };

  const onReset = (): void => setPending({ ...(currentFilters ?? {}) });
  const onApplyClick = (): void => onApply(pending);

  return (
    <div className="flex max-h-[80vh] flex-col">
      <header className="border-b border-slate-200 px-5 py-3">
        <h2 className="text-lg font-semibold text-slate-900">
          Filter — {displayName}
        </h2>
        <p className="mt-0.5 text-xs text-slate-500">db_name: <span className="font-mono">{db}</span></p>
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
        {isError && (
          <p className="text-sm text-red-700">
            Failed to load fields: {error instanceof Error ? error.message : "unknown error"}
          </p>
        )}
        {data && data.fields.length === 0 && (
          <p className="text-sm text-slate-600">
            No filterable fields for this dataset.
          </p>
        )}
        {data && data.fields.length > 0 && (
          <ul className="space-y-5">
            {data.fields.map((f) => (
              <li key={f.field}>
                <FieldControl field={f} spec={pending[f.field] ?? null} onChange={(s) => setSpec(f.field, s)} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={onReset}>Reset</Button>
        <Button
          onClick={onApplyClick}
          className="border-blue-600 bg-blue-600 text-white hover:bg-blue-700"
        >
          Apply Filters
        </Button>
      </footer>
    </div>
  );
}

interface FieldControlProps {
  field: FieldMeta;
  spec: FilterSpec | null;
  onChange: (next: FilterSpec | null) => void;
}

function FieldControl({ field, spec, onChange }: FieldControlProps) {
  if (field.kind === "categorical") {
    const levels = field.levels ?? [];
    // Value is string[] when set; null/empty means "no filter on this field".
    const selected: string[] = spec && spec.type === "categorical" && Array.isArray(spec.value)
      ? (spec.value as string[])
      : [];
    const toggle = (level: string, checked: boolean): void => {
      const set = new Set(selected);
      if (checked) set.add(level);
      else set.delete(level);
      const next = [...set];
      if (next.length === 0) onChange(null);
      else onChange({ type: "categorical", value: next });
    };
    return (
      <div>
        <FieldLabel field={field} />
        {levels.length === 0 ? (
          <p className="text-xs text-slate-500">No cached levels for this field.</p>
        ) : (
          <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
            {levels.map((lv) => {
              const id = `flt-${field.field}-${lv}`;
              const checked = selected.includes(lv);
              return (
                <li key={lv}>
                  <label htmlFor={id} className="flex items-center gap-1.5 text-sm">
                    <Checkbox
                      id={id}
                      checked={checked}
                      onChange={(e) => toggle(lv, e.currentTarget.checked)}
                    />
                    <span className="truncate">{lv}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  if (field.kind === "numeric") {
    const lo = typeof field.numericMin === "number" ? field.numericMin : 0;
    const hi = typeof field.numericMax === "number" ? field.numericMax : 1;
    const safeLo = Number.isFinite(lo) ? lo : 0;
    const safeHi = Number.isFinite(hi) && hi > safeLo ? hi : safeLo + 1;
    // numeric spec.value is [min, max].
    const cur: [number, number] = spec && spec.type === "numeric" && Array.isArray(spec.value) && spec.value.length === 2
      ? [Number((spec.value as number[])[0]), Number((spec.value as number[])[1])]
      : [safeLo, safeHi];
    const step = (safeHi - safeLo) / 100 || 0.01;
    const setMin = (n: number): void => {
      const next: [number, number] = [Math.min(n, cur[1]), cur[1]];
      onChange({ type: "numeric", value: next });
    };
    const setMax = (n: number): void => {
      const next: [number, number] = [cur[0], Math.max(n, cur[0])];
      onChange({ type: "numeric", value: next });
    };
    return (
      <div>
        <FieldLabel field={field} />
        <div className="mt-1 flex items-center gap-3 text-xs text-slate-700">
          <span>
            min: <span className="font-mono">{cur[0]}</span>
          </span>
          <input
            type="range"
            min={safeLo}
            max={safeHi}
            step={step}
            value={cur[0]}
            onChange={(e) => setMin(Number(e.currentTarget.value))}
            className="flex-1"
            aria-label={`${field.field} min`}
          />
          <span>
            max: <span className="font-mono">{cur[1]}</span>
          </span>
          <input
            type="range"
            min={safeLo}
            max={safeHi}
            step={step}
            value={cur[1]}
            onChange={(e) => setMax(Number(e.currentTarget.value))}
            className="flex-1"
            aria-label={`${field.field} max`}
          />
          {spec !== null && (
            <Button size="sm" onClick={() => onChange(null)}>
              clear
            </Button>
          )}
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          data range: [{safeLo}, {safeHi}]
        </p>
      </div>
    );
  }

  // bool
  const id = `flt-${field.field}`;
  const checked = spec && spec.type === "bool" ? Boolean(spec.value) : false;
  const isSet = spec !== null;
  return (
    <div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={checked}
          onChange={(e) => onChange({ type: "bool", value: e.currentTarget.checked })}
        />
        <label htmlFor={id} className="text-sm font-medium text-slate-800">
          {field.field}
        </label>
        {isSet && (
          <Button size="sm" onClick={() => onChange(null)}>
            clear
          </Button>
        )}
      </div>
    </div>
  );
}

function FieldLabel({ field }: { field: FieldMeta }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-sm font-medium text-slate-800">{field.field}</span>
      <span className="text-xs font-mono text-slate-500">
        {field.kind}
        {field.role ? ` · ${field.role}` : ""}
      </span>
    </div>
  );
}
