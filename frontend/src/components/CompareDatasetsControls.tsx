import {
  PROMOTER_SET_ALIAS,
  PROMOTER_SET_ORDER,
  PROMOTER_SET_TOOLTIPS,
} from "@/lib/comparison-palette";

// Binding-method + promoter-set selectors for the Compare Datasets tab.
//
// Mirrors the reference's per-tab sidebar controls for "Compare Datasets"
// (reference/tfbpshiny/modules/comparison/server/workspace.py:531-549):
//   - cd_binding_method: select "Promoter Enrichment" | "Peaks", default
//     "Promoter Enrichment".
//   - cd_promoter_set:   select Kang/Mindel/500bp/Intergenic (labelled with the
//     _PROMOTER_SET_ALIAS strings), default "Kang".
// Together they re-resolve which scoring variant db supplies each matrix row
// (see resolveCompareDatasetsDb). Default = Promoter Enrichment + Kang, which is
// the base/Kang matrix the page rendered before this control existed.
//
// Placement note: the reference puts these in the tab-aware sidebar; we render
// them INLINE above the matrix, consistent with how the Compare Promoter
// Definitions tab carries its own PromoterSetSelector inline (the shared
// ComparisonSidebar stays global — Top N + Responsiveness only).
//
// The selection is owned by the parent route and URL-encoded via
// `?cd_method=` / `?cd_promoter_set=` (absent => the defaults).

export type CompareDatasetsMethod = "Promoter Enrichment" | "Peaks";

export interface CompareDatasetsControlsProps {
  method: CompareDatasetsMethod;
  promoterSet: string;
  onMethodChange: (method: CompareDatasetsMethod) => void;
  onPromoterSetChange: (promoterSet: string) => void;
}

const SELECT_CLASS =
  "rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-800 " +
  "focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 " +
  "disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400";

export function CompareDatasetsControls({
  method,
  promoterSet,
  onMethodChange,
  onPromoterSetChange,
}: CompareDatasetsControlsProps) {
  // The promoter set is irrelevant under Peaks (resolveCompareDatasetsDb ignores
  // it), so disable the control there rather than leaving a dead select that
  // silently does nothing. The reference leaves it enabled-but-ignored; this is
  // a small, deliberate UX divergence.
  const peaks = method === "Peaks";
  return (
    <div className="mb-3 flex flex-wrap items-end gap-4 text-sm">
      <label className="flex flex-col gap-1">
        <span className="font-medium text-slate-700">Binding Method</span>
        <select
          name="cd-binding-method"
          className={SELECT_CLASS}
          value={method}
          onChange={(e) =>
            onMethodChange(e.target.value as CompareDatasetsMethod)
          }
        >
          <option value="Promoter Enrichment">Promoter Enrichment</option>
          <option value="Peaks">Peaks</option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-medium text-slate-700">Promoter Set</span>
        <select
          name="cd-promoter-set"
          className={SELECT_CLASS}
          value={promoterSet}
          disabled={peaks}
          title={
            peaks
              ? "Promoter set applies only to the Promoter Enrichment method."
              : undefined
          }
          onChange={(e) => onPromoterSetChange(e.target.value)}
        >
          {PROMOTER_SET_ORDER.map((ps) => (
            <option key={ps} value={ps} title={PROMOTER_SET_TOOLTIPS[ps]}>
              {PROMOTER_SET_ALIAS[ps]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
