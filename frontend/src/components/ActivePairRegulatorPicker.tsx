import { useMemo, useState } from "react";
import type { Schemas } from "@/api/client";
import { Input } from "@/components/ui/input";

// ActivePairRegulatorPicker narrows the regulator selectize to only the
// regulators that actually appear in the active correlation pairs.
// Mirrors docs/parity/binding.md row 10 and Shiny's regulator_selector
// (workspace.py:366-407) which builds its choices from
// `_all_corr_data()` rather than the global regulator table.
//
// Renders a native <select> when the candidate set is small (< 50) so
// keyboard nav and standard form semantics Just Work; otherwise falls
// back to a typeahead-style filter on top of a scrollable list.
//
// Display label: locus tag (with optional symbol when present in
// regulatorDisplayMap). The corr response doesn't currently carry the
// gene symbol, so the parent supplies a best-effort map. Sorting is
// case-insensitive by label, matching Shiny's `sorted(..., key=str.lower)`
// in workspace.py:401.

const TYPEAHEAD_THRESHOLD = 50;

export interface ActivePairRegulatorPickerProps {
  corr: Schemas["CorrResponse"];
  value: string | null;
  onChange: (locusTag: string) => void;
  // Optional locus_tag → display label (symbol or "SYMBOL (LOCUS)").
  // Falls back to the bare locus tag when absent.
  regulatorDisplayMap?: Record<string, string>;
}

interface Option {
  locusTag: string;
  label: string;
  // Lower-cased label for case-insensitive sort + filter.
  labelLower: string;
}

export function ActivePairRegulatorPicker({
  corr,
  value,
  onChange,
  regulatorDisplayMap,
}: ActivePairRegulatorPickerProps) {
  const options = useMemo<Option[]>(() => {
    const seen = new Set<string>();
    const out: Option[] = [];
    for (const pair of corr.pairs ?? []) {
      for (const pt of pair.points) {
        if (seen.has(pt.regulatorLocusTag)) continue;
        seen.add(pt.regulatorLocusTag);
        const label = regulatorDisplayMap?.[pt.regulatorLocusTag] ?? pt.regulatorLocusTag;
        out.push({
          locusTag: pt.regulatorLocusTag,
          label,
          labelLower: label.toLowerCase(),
        });
      }
    }
    out.sort((a, b) => a.labelLower.localeCompare(b.labelLower));
    return out;
  }, [corr.pairs, regulatorDisplayMap]);

  const [query, setQuery] = useState("");
  const useTypeahead = options.length >= TYPEAHEAD_THRESHOLD;

  if (options.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No regulators present in the active pairs.
      </p>
    );
  }

  if (!useTypeahead) {
    return (
      <select
        className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>
          Select a regulator
        </option>
        {options.map((o) => (
          <option key={o.locusTag} value={o.locusTag}>
            {o.label} {o.label === o.locusTag ? "" : `(${o.locusTag})`}
          </option>
        ))}
      </select>
    );
  }

  const filtered = query
    ? options.filter(
        (o) =>
          o.labelLower.includes(query.toLowerCase()) ||
          o.locusTag.toLowerCase().includes(query.toLowerCase()),
      )
    : options;

  return (
    <div className="space-y-2">
      <Input
        placeholder="filter regulator (locus tag or symbol)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="max-h-48 overflow-y-auto rounded-md border">
        {filtered.map((o) => (
          <li key={o.locusTag}>
            <button
              type="button"
              className={`w-full px-2 py-1 text-left text-sm hover:bg-slate-100 ${
                value === o.locusTag ? "bg-slate-200" : ""
              }`}
              onClick={() => onChange(o.locusTag)}
            >
              {o.label}{" "}
              {o.label === o.locusTag ? null : (
                <span className="text-slate-500">({o.locusTag})</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
