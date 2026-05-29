// Per-dataset filter modal — Task B4 of the Phase A overnight rebuild.
//
// Scope mirrors P0 rows of docs/parity/select_datasets.md §2:
//  - row 5  per-row Filter button opens this modal
//  - row 7  categorical fields render as multi-select (checkbox list)
//  - row 8  numeric fields render as a two-handle range
//  - row 9  bool fields render as a checkbox
//  - row 16 Reset / Apply Filters buttons in the modal footer
//
// Task C4 adds (schema_version=4 metadata):
//  - row 9   description tooltip on field label via native title=
//  - row 10  level_definitions JSON → human-readable checkbox labels
//  - row 19  PARTIAL: numericLevelSort honored for categorical levels;
//            full cascade narrowing deferred (needs runtime joins — see
//            docs/parity/auto-status/polish.md C4 entry).
//
// Task C5 adds:
//  - rows 12, 14: per-field "Apply to all datasets" switch in the modal,
//                 shown only for categorical/numeric fields that exist
//                 in every active dataset's field manifest. Booleans are
//                 intentionally excluded — "apply to all" rarely matches
//                 user intent for booleans (the Shiny code in
//                 ui.py:63-69 also restricts apply-to-all to common
//                 char-typed fields).
//  - rows 15, 30, 31: when the current filter for a field carries a
//                 `fromPair` annotation, surface an inline cleanup link
//                 that clears the filter outright.
//
// State model: this component holds a `pending` map locally and commits it
// to URL via `onApply` only when the user clicks "Apply Filters". The page
// owns the URL `?filters=` writeback; we hand back the next per-field
// FilterSpec map for this dataset PLUS the set of field names that the
// user toggled "apply to all" for, so the page can mirror those into
// every active dataset's filter block.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Schemas } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { sortLevels } from "@/lib/sort-levels";
import {
  readFromPair,
  readApplyToAll,
  withApplyToAll,
  defaultApplyToAll,
  REGULATOR_LOCUS_TAG_FIELD,
  type AnnotatedFilterSpec,
} from "@/lib/filter-spec";
import { RegulatorFilterCard } from "@/components/RegulatorFilterCard";

type FilterSpec = Schemas["FilterSpec"];
type FieldMeta = Schemas["FieldMeta"];

export interface ApplyResult {
  /**
   * Per-field filter map for THIS dataset (post-apply). Each common-field
   * and the regulator spec carries an `applyToAll` annotation (see
   * `lib/filter-spec.ts`); the page reads it to decide propagation +
   * retroactive-clear scope, mirroring Shiny's `apply_to_all`.
   */
  next: Record<string, FilterSpec>;
}

export interface DatasetFilterModalProps {
  open: boolean;
  onClose: () => void;
  db: string;
  displayName: string;
  /** The current (committed) filters for this dataset; null = no filters set. */
  currentFilters: Record<string, FilterSpec> | null;
  /**
   * Set of field names that appear in every active dataset's field
   * manifest. Only these are eligible for the "Apply to all" toggle
   * (rows 12, 14). Empty/undefined disables the toggle entirely.
   */
  commonFields?: Set<string>;
  onApply: (result: ApplyResult) => void;
  /**
   * Reset this dataset: clear its filters AND every active dataset's
   * common-field filters, then close — mirrors Shiny's
   * `_reset_filter_modal` (`server/sidebar.py:437-475`). Committed
   * immediately (Shiny parity), not staged behind Apply.
   */
  onResetDataset: () => void;
}

export function DatasetFilterModal(props: DatasetFilterModalProps) {
  const { open, onClose, db, displayName, currentFilters, commonFields, onApply, onResetDataset } =
    props;
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
          commonFields={commonFields ?? new Set()}
          onApply={onApply}
          onResetDataset={onResetDataset}
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
  commonFields: Set<string>;
  onApply: (result: ApplyResult) => void;
  onResetDataset: () => void;
  onClose: () => void;
}

function ModalBody({
  db,
  displayName,
  currentFilters,
  commonFields,
  onApply,
  onResetDataset,
  onClose,
}: ModalBodyProps) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: qk.datasetFields(db),
    queryFn: () => api.datasetFields({ db }),
  });

  const initial = useMemo<Record<string, AnnotatedFilterSpec>>(
    () => ({ ...(currentFilters ?? {}) }) as Record<string, AnnotatedFilterSpec>,
    [currentFilters],
  );
  const [pending, setPending] = useState<Record<string, AnnotatedFilterSpec>>(initial);
  // Apply-to-all toggle OVERRIDES, keyed by field name — only holds entries
  // the user explicitly flipped this session. The effective value falls back
  // to the persisted annotation, then the field-type default (see
  // `effectiveApplyToAll`). Cleared on each modal open (re-mounted upstream).
  const [applyToAll, setApplyToAll] = useState<Record<string, boolean>>({});

  // field → role lookup so condition fields default their apply-to-all to ON.
  const roleByField = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of data?.fields ?? []) m.set(f.field, f.role ?? "");
    return m;
  }, [data]);

  // If the parent flips currentFilters mid-modal (e.g. the URL changes via
  // back/forward navigation or the matrix from_pair clear), rehydrate pending.
  // Note: the regulator card's "Clear" only updates this local pending — like
  // every other field edit it commits on "Apply Filters", not immediately.
  useEffect(() => {
    setPending({ ...(currentFilters ?? {}) } as Record<string, AnnotatedFilterSpec>);
  }, [currentFilters]);

  const setSpec = (field: string, spec: AnnotatedFilterSpec | null): void => {
    setPending((prev) => {
      const next = { ...prev };
      if (spec === null) delete next[field];
      else next[field] = spec;
      return next;
    });
  };

  /**
   * Effective apply-to-all for a field: an explicit session flip wins; else
   * the value persisted in the current filters; else the field-type default
   * (regulator + experimental_condition → ON, everything else OFF).
   */
  const effectiveApplyToAll = (field: string): boolean => {
    if (field in applyToAll) return applyToAll[field] === true;
    const persisted = readApplyToAll(currentFilters?.[field]);
    if (persisted !== undefined) return persisted;
    return defaultApplyToAll(field, roleByField.get(field));
  };
  const setApplyToAllFor = (field: string, on: boolean): void =>
    setApplyToAll((prev) => ({ ...prev, [field]: on }));

  // SD-6b: Reset clears this dataset's filters AND common-field filters from
  // every active dataset, committed immediately (Shiny `_reset_filter_modal`,
  // sidebar.py:437-475). The page owns the cross-dataset write; we delegate.
  const onReset = (): void => {
    onResetDataset();
    onClose();
  };
  const onApplyClick = (): void => {
    // Stamp the apply-to-all annotation onto every common field + the
    // regulator spec so it persists in `?filters=` and the page can mirror /
    // retroactively clear correctly. Dataset-specific fields never carry it.
    const next: Record<string, FilterSpec> = {};
    for (const [field, spec] of Object.entries(pending)) {
      if (!spec) continue;
      const annotates =
        field === REGULATOR_LOCUS_TAG_FIELD || commonFields.has(field);
      next[field] = annotates ? withApplyToAll(spec, effectiveApplyToAll(field)) : spec;
    }
    onApply({ next });
  };

  return (
    <div className="flex max-h-[80vh] flex-col">
      <header className="border-b border-slate-200 px-5 py-3">
        <h2 className="text-lg font-semibold text-slate-900">
          Filter — {displayName}
        </h2>
        <p className="mt-0.5 text-xs text-slate-500">db_name: <span className="font-mono">{db}</span></p>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {/* SD-5: Regulator card, prepended above the generic fields (Shiny
            puts it atop the "Common Characteristics" column). Always shown —
            every dataset keys its meta rows by regulator_locus_tag, which is
            intentionally absent from /datasets/{db}/fields. */}
        <RegulatorFilterCard
          db={db}
          spec={pending[REGULATOR_LOCUS_TAG_FIELD] ?? null}
          applyToAll={effectiveApplyToAll(REGULATOR_LOCUS_TAG_FIELD)}
          onChange={(s) => setSpec(REGULATOR_LOCUS_TAG_FIELD, s)}
          onApplyToAllChange={(on) => setApplyToAllFor(REGULATOR_LOCUS_TAG_FIELD, on)}
          onClear={() => setSpec(REGULATOR_LOCUS_TAG_FIELD, null)}
        />

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
            {data.fields.map((f) => {
              const isCommon = commonFields.has(f.field) && f.kind !== "bool";
              return (
                <li key={f.field}>
                  <FieldControl
                    field={f}
                    spec={pending[f.field] ?? null}
                    onChange={(s) => setSpec(f.field, s)}
                    applyToAllEligible={isCommon}
                    applyToAll={effectiveApplyToAll(f.field)}
                    onApplyToAllChange={(on) => setApplyToAllFor(f.field, on)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={onReset}>Reset</Button>
        <Button
          onClick={onApplyClick}
          className="border-blue-600 bg-blue-600 text-black hover:bg-blue-700"
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
  applyToAllEligible: boolean;
  applyToAll: boolean;
  onApplyToAllChange: (on: boolean) => void;
}

function FieldControl(props: FieldControlProps) {
  const { field, spec, onChange, applyToAllEligible, applyToAll, onApplyToAllChange } =
    props;

  // C5 (rows 15, 30, 31): when the current filter carries a `fromPair`
  // annotation (set by CommonRegulatorsModal), surface an inline link
  // that clears the filter and unhighlights the matrix cell.
  const fromPair = readFromPair(spec);

  const header = (
    <>
      <FieldLabel field={field} />
      {applyToAllEligible && (
        <label
          className="mt-1 flex items-center gap-2 text-xs text-slate-600"
          data-testid={`apply-to-all-${field.field}`}
        >
          <Checkbox
            id={`apply-to-all-cb-${field.field}`}
            checked={applyToAll}
            onChange={(e) => onApplyToAllChange(e.currentTarget.checked)}
          />
          <span>Apply this filter to all active datasets that have this field</span>
        </label>
      )}
      {fromPair && (
        <p
          className="mt-1 text-xs text-amber-700"
          data-testid={`from-pair-${field.field}`}
        >
          These regulators came from the {fromPair[0]} ∩ {fromPair[1]} pair.{" "}
          <button
            type="button"
            className="underline hover:text-amber-900"
            onClick={() => onChange(null)}
          >
            Click to clear.
          </button>
        </p>
      )}
    </>
  );

  if (field.kind === "categorical") {
    // C4: honor numericLevelSort (e.g. hackett.time renders "10" < "45" < "90"
    // rather than "10" < "45" < "90" risking lex-mangling once we have 3+ digits).
    const levels = sortLevels(field.levels ?? [], field.numericLevelSort);
    // C4: level_definitions is `{level: label}`. When present, render the
    // human-readable label next to the checkbox; fall back to the raw level
    // string otherwise. Defensive cast — wire type is `unknown`.
    const levelLabels = field.levelDefinitions ?? {};
    const labelFor = (lv: string): string => {
      const raw = (levelLabels as Record<string, unknown>)[lv];
      return typeof raw === "string" && raw.length > 0 ? raw : lv;
    };
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
        {header}
        {levels.length === 0 ? (
          <p className="text-xs text-slate-500">No cached levels for this field.</p>
        ) : (
          <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
            {levels.map((lv) => {
              const id = `flt-${field.field}-${lv}`;
              const checked = selected.includes(lv);
              const label = labelFor(lv);
              return (
                <li key={lv}>
                  <label htmlFor={id} className="flex items-center gap-1.5 text-sm">
                    <Checkbox
                      id={id}
                      checked={checked}
                      onChange={(e) => toggle(lv, e.currentTarget.checked)}
                    />
                    <span className="truncate" title={label !== lv ? lv : undefined}>
                      {label}
                    </span>
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
        {header}
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

  // bool — intentionally no Apply-to-all UI (see comment at the
  // applyToAllEligible filter in ModalBody above).
  const id = `flt-${field.field}`;
  const checked = spec && spec.type === "bool" ? Boolean(spec.value) : false;
  const isSet = spec !== null;
  const description = field.description && field.description.length > 0 ? field.description : undefined;
  return (
    <div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={checked}
          onChange={(e) => onChange({ type: "bool", value: e.currentTarget.checked })}
        />
        <label
          htmlFor={id}
          className="text-sm font-medium text-slate-800"
          title={description}
          data-testid={`field-label-${field.field}`}
        >
          {field.field}
        </label>
        {isSet && (
          <Button size="sm" onClick={() => onChange(null)}>
            clear
          </Button>
        )}
      </div>
      {fromPair && (
        <p
          className="mt-1 text-xs text-amber-700"
          data-testid={`from-pair-${field.field}`}
        >
          These regulators came from the {fromPair[0]} ∩ {fromPair[1]} pair.{" "}
          <button
            type="button"
            className="underline hover:text-amber-900"
            onClick={() => onChange(null)}
          >
            Click to clear.
          </button>
        </p>
      )}
    </div>
  );
}

function FieldLabel({ field }: { field: FieldMeta }) {
  // C4 (audit row 9): native browser tooltip via title= when the
  // field_manifest.description is non-empty. Browser handles HTML escaping
  // for attribute values, so no manual escape needed.
  const description = field.description && field.description.length > 0 ? field.description : undefined;
  return (
    <div className="flex items-baseline justify-between">
      <span
        className="text-sm font-medium text-slate-800"
        title={description}
        data-testid={`field-label-${field.field}`}
      >
        {field.field}
      </span>
      <span className="text-xs font-mono text-slate-500">
        {field.kind}
        {field.role ? ` · ${field.role}` : ""}
      </span>
    </div>
  );
}
