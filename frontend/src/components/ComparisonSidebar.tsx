import { Input } from "@/components/ui/input";

// Sidebar controls for the Comparison route. Mirror
// reference/tfbpshiny/modules/comparison/ui.py:
//   - top_n: numeric, 1..500 step 5, default 25
//   - responsiveness_preset: radio "Relaxed" | "Stringent", default "Relaxed"
//     (replaces the old Min |effect| / Max p-value sliders — CMP-4/CMP-5)
//   - facet_by: radio "binding" | "perturbation", default "binding"
//
// The preset strings "Relaxed" and "Stringent" are sent verbatim as
// `?preset=` to the backend (comparison_topn.go `responsivenessPresets` map;
// case-sensitive). Tooltips are copied verbatim from ui.py:37-52.
//
// Every change is pushed through `onChange` so the parent route can mirror
// the new value into the URL — URL is the canonical state.

export type ResponsivenessPreset = "Relaxed" | "Stringent";

export interface ComparisonSidebarChange {
  topN?: number;
  preset?: ResponsivenessPreset;
  facetBy?: "binding" | "perturbation";
}

export interface ComparisonSidebarProps {
  topN: number;
  preset: ResponsivenessPreset;
  facetBy: "binding" | "perturbation";
  onChange: (next: ComparisonSidebarChange) => void;
}

export function ComparisonSidebar({
  topN,
  preset,
  facetBy,
  onChange,
}: ComparisonSidebarProps) {
  return (
    <aside className="space-y-5 rounded-md border border-slate-200 bg-white p-3 text-sm">
      <div>
        <label className="mb-1 block font-medium text-slate-700" htmlFor="cmp-top-n">
          Top N
        </label>
        <Input
          id="cmp-top-n"
          type="number"
          min={1}
          max={500}
          step={5}
          value={topN}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange({ topN: clamp(v, 1, 500) });
          }}
        />
      </div>

      {/* Responsiveness preset — mirrors ui.py:32-54. Replaces the old
          Min |effect| / Max p-value sliders (CMP-4/CMP-5). */}
      <fieldset>
        <legend className="mb-1 font-medium text-slate-700">Responsiveness</legend>
        <div className="space-y-1">
          <label
            className="flex items-center gap-2"
            title="Applies a uniform pvalue < 0.05 threshold. Hover over perturbation column headers in Compare Datasets for per-dataset details."
          >
            <input
              type="radio"
              name="cmp-preset"
              value="Relaxed"
              checked={preset === "Relaxed"}
              onChange={() => onChange({ preset: "Relaxed" })}
            />
            <span>Relaxed</span>
          </label>
          <label
            className="flex items-center gap-2"
            title="Uses the original authors' thresholds for each dataset. Hover over perturbation column headers in Compare Datasets for per-dataset details."
          >
            <input
              type="radio"
              name="cmp-preset"
              value="Stringent"
              checked={preset === "Stringent"}
              onChange={() => onChange({ preset: "Stringent" })}
            />
            <span>Stringent</span>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 font-medium text-slate-700">Facet by</legend>
        <div className="space-y-1">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="cmp-facet-by"
              value="binding"
              checked={facetBy === "binding"}
              onChange={() => onChange({ facetBy: "binding" })}
            />
            <span>Binding source</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="cmp-facet-by"
              value="perturbation"
              checked={facetBy === "perturbation"}
              onChange={() => onChange({ facetBy: "perturbation" })}
            />
            <span>Perturbation source</span>
          </label>
        </div>
      </fieldset>
    </aside>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
