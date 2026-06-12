import { Checkbox } from "@/components/ui/checkbox";
import {
  PROMOTER_SET_ALIAS,
  PROMOTER_SET_ORDER,
  PROMOTER_SET_TOOLTIPS,
} from "@/lib/comparison-palette";

// Promoter-set checkbox group for the Compare Promoter Definitions tab.
//
// Mirrors the reference's `cp_included_promoter_sets` checkbox group
// (reference/tfbpshiny/modules/comparison/server/workspace.py:552-568): one box
// per promoter set, label = PROMOTER_SET_ALIAS[ps], hover tooltip =
// PROMOTER_SET_TOOLTIPS[ps], DEFAULT = all selected. Selecting fewer sets
// narrows which promoter-set variant binding dbs are compared.
//
// `selected` is owned by the parent route (URL-encoded via ?promoterSets=).
// Toggling a box re-derives the next list by filtering PROMOTER_SET_ORDER to the
// new membership, so the emitted list is always in canonical order regardless of
// click order.

export interface PromoterSetSelectorProps {
  selected: string[];
  onChange: (next: string[]) => void;
}

export function PromoterSetSelector({
  selected,
  onChange,
}: PromoterSetSelectorProps) {
  const selectedSet = new Set(selected);

  const toggle = (ps: string, checked: boolean): void => {
    const nextSet = new Set(selectedSet);
    if (checked) nextSet.add(ps);
    else nextSet.delete(ps);
    // Re-derive in canonical PROMOTER_SET_ORDER order, never click order.
    onChange(PROMOTER_SET_ORDER.filter((p) => nextSet.has(p)));
  };

  return (
    <fieldset className="mb-3">
      <legend className="mb-1 font-medium text-slate-700">Promoter Sets</legend>
      <div className="space-y-1">
        {PROMOTER_SET_ORDER.map((ps) => (
          <label
            key={ps}
            className="flex items-center gap-2"
            title={PROMOTER_SET_TOOLTIPS[ps]}
          >
            <Checkbox
              name="cp-promoter-sets"
              value={ps}
              checked={selectedSet.has(ps)}
              onChange={(e) => toggle(ps, e.target.checked)}
            />
            <span>{PROMOTER_SET_ALIAS[ps]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
