// RegulatorFilterCard — Task SD-5 (in-modal Regulator selectize card).
//
// Mirrors Shiny's Regulator card prepended to the filter modal's "Common
// Characteristics" column (`reference/.../select_datasets/ui.py:329-417`):
// a searchable multi-select over the FULL per-dataset regulator list with
// `SYMBOL (LOCUS_TAG)` display labels, an "Apply to all datasets" switch
// (default ON, owned by the parent), a Clear button, and a restricted
// "from_pair" context variant.
//
// Backend: GET /api/v/{v}/datasets/{db}/regulators returns
// `[{locusTag, symbol, display}]` already formatted as "SYMBOL (LOCUS_TAG)"
// (or the bare locus tag when no symbol). Datasets can carry hundreds of
// regulators, so the choices render as a search box + removable chips
// rather than a checkbox grid (the generic categorical control would show
// "No cached levels" — regulator_locus_tag exceeds LEVEL_CACHE_THRESHOLD
// and is intentionally absent from /datasets/{db}/fields).
//
// State model: this is a controlled component. The parent (DatasetFilterModal)
// owns `pending["regulator_locus_tag"]` and the apply-to-all flag; the card
// reports edits via `onChange` / `onApplyToAllChange` / `onClear`.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  REGULATOR_LOCUS_TAG_FIELD,
  readFromPair,
  type AnnotatedFilterSpec,
} from "@/lib/filter-spec";

export interface RegulatorFilterCardProps {
  /** Dataset whose regulator list powers the choices. */
  db: string;
  /** Current regulator filter spec (null = no regulator filter set). */
  spec: AnnotatedFilterSpec | null;
  /** Whether "Apply to all datasets" is on (controlled by the parent). */
  applyToAll: boolean;
  /** Report a new spec (null clears the regulator filter). */
  onChange: (next: AnnotatedFilterSpec | null) => void;
  /** Report a flip of the Apply-to-all toggle. */
  onApplyToAllChange: (on: boolean) => void;
  /** Clear the regulator filter from every dataset (non-from_pair mode only). */
  onClear: () => void;
}

/** Pull the locus-tag list out of a categorical spec, defensively. */
function specTags(spec: AnnotatedFilterSpec | null): string[] {
  if (!spec || spec.type !== "categorical" || !Array.isArray(spec.value)) {
    return [];
  }
  return (spec.value as unknown[]).filter((v): v is string => typeof v === "string");
}

export function RegulatorFilterCard(props: RegulatorFilterCardProps) {
  const { db, spec, applyToAll, onChange, onApplyToAllChange, onClear } = props;
  const [search, setSearch] = useState("");

  const { data, isLoading, isError } = useQuery({
    queryKey: qk.datasetRegulators(db),
    queryFn: ({ signal }) => api.datasetRegulators({ db }, signal),
    enabled: db.length > 0,
  });

  const regulators = useMemo(() => data?.regulators ?? [], [data]);
  const labelByTag = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of regulators) m.set(r.locusTag, r.display || r.locusTag);
    return m;
  }, [regulators]);
  const labelFor = (tag: string): string => labelByTag.get(tag) ?? tag;

  const selected = useMemo(() => specTags(spec), [spec]);
  const fromPair = readFromPair(spec);
  const restricted = fromPair !== null;

  // Choice universe. In from_pair mode Shiny restricts the selectize to the
  // current common set (ui.py:345-349); otherwise it's the full list.
  const choiceTags = useMemo(() => {
    if (restricted) return selected;
    return regulators.map((r) => r.locusTag);
  }, [restricted, selected, regulators]);

  // Search-filtered, not-already-selected options.
  const q = search.trim().toLowerCase();
  const options = useMemo(() => {
    const selectedSet = new Set(selected);
    return choiceTags.filter((tag) => {
      if (selectedSet.has(tag)) return false;
      if (q === "") return true;
      const label = labelFor(tag).toLowerCase();
      return label.includes(q) || tag.toLowerCase().includes(q);
    });
  }, [choiceTags, selected, q, labelByTag]);

  const emit = (tags: string[]): void => {
    if (tags.length === 0) {
      onChange(null);
      return;
    }
    // Preserve the fromPair annotation when narrowing a pairwise filter so the
    // matrix cell stays highlighted (Select.tsx keys the highlight off it).
    const next: AnnotatedFilterSpec = { type: "categorical", value: tags };
    if (fromPair) next.fromPair = fromPair;
    onChange(next);
  };

  const add = (tag: string): void => {
    if (selected.includes(tag)) return;
    emit([...selected, tag]);
  };
  const remove = (tag: string): void => {
    emit(selected.filter((t) => t !== tag));
  };

  return (
    <div
      className="rounded-md border border-slate-200 bg-white p-3"
      data-testid="regulator-filter-card"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-800">Regulator</span>
        {!restricted && (
          <div className="flex items-center gap-3">
            <Button size="sm" data-testid="regulator-clear" onClick={onClear}>
              Clear
            </Button>
            <label
              className="flex items-center gap-1.5 text-xs text-slate-600"
              data-testid={`apply-to-all-${REGULATOR_LOCUS_TAG_FIELD}`}
            >
              <Checkbox
                id={`apply-to-all-cb-${REGULATOR_LOCUS_TAG_FIELD}`}
                checked={applyToAll}
                onChange={(e) => onApplyToAllChange(e.currentTarget.checked)}
              />
              <span>Apply to all datasets</span>
            </label>
          </div>
        )}
      </div>

      {restricted && fromPair && (
        <p
          className="mb-2 text-xs text-amber-700"
          data-testid="regulator-from-pair-note"
        >
          Regulators are limited to the {selected.length.toLocaleString()} common
          regulators between {fromPair[0]} and {fromPair[1]}. To clear this,
          deselect the highlighted cell in the matrix.
        </p>
      )}

      {/* Selected chips */}
      {selected.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5" data-testid="regulator-chips">
          {selected.map((tag) => (
            <li key={tag}>
              <span
                className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800"
                data-testid={`regulator-chip-${tag}`}
              >
                <span className="truncate">{labelFor(tag)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${labelFor(tag)}`}
                  className="ml-0.5 leading-none text-blue-600 hover:text-blue-900"
                  onClick={() => remove(tag)}
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <Input
        type="search"
        placeholder="search regulator (symbol or locus tag)"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        aria-label="search regulator"
        data-testid="regulator-search"
      />

      {isLoading && <Skeleton className="mt-2 h-24 w-full" />}
      {isError && (
        <p className="mt-2 text-xs text-red-700">Failed to load regulators.</p>
      )}
      {data && (
        <ul className="mt-2 max-h-48 overflow-y-auto rounded-md border border-slate-200">
          {options.length === 0 ? (
            <li className="px-2 py-1 text-xs text-slate-500">
              {restricted && selected.length === 0
                ? "No regulators available for this pair."
                : q !== ""
                  ? "No regulators match your search."
                  : "All matching regulators are selected."}
            </li>
          ) : (
            options.map((tag) => (
              <li key={tag}>
                <button
                  type="button"
                  className="w-full px-2 py-1 text-left text-sm hover:bg-slate-100"
                  data-testid={`regulator-option-${tag}`}
                  onClick={() => add(tag)}
                >
                  {labelFor(tag)}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
