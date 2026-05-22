import { Input } from "@/components/ui/input";

// Sidebar controls for the Comparison route. Mirror
// reference/tfbpshiny/modules/comparison/server/sidebar.py:91-165:
//   - top_n: numeric, 1..500 step 5, default 25
//   - effect: slider 0.0..5.0 step 0.1, default 0.0
//   - pvalue: slider 0.001..1.0 step 0.001, default 0.05
//   - facet_by: radio "binding" | "perturbation", default "binding"
//
// Every change is pushed through `onChange` so the parent route can mirror
// the new value into the URL — URL is the canonical state.

export interface ComparisonSidebarChange {
  topN?: number;
  effect?: number;
  pvalue?: number;
  facetBy?: "binding" | "perturbation";
}

export interface ComparisonSidebarProps {
  topN: number;
  effect: number;
  pvalue: number;
  facetBy: "binding" | "perturbation";
  onChange: (next: ComparisonSidebarChange) => void;
}

export function ComparisonSidebar({
  topN,
  effect,
  pvalue,
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

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <label className="font-medium text-slate-700" htmlFor="cmp-effect">
            Min |effect|
          </label>
          <span className="font-mono text-xs text-slate-500">{effect.toFixed(1)}</span>
        </div>
        <input
          id="cmp-effect"
          type="range"
          min={0}
          max={5}
          step={0.1}
          value={effect}
          onChange={(e) =>
            onChange({ effect: clamp(Number(e.target.value), 0, 5) })
          }
          className="w-full"
        />
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <label className="font-medium text-slate-700" htmlFor="cmp-pvalue">
            Max p-value
          </label>
          <span className="font-mono text-xs text-slate-500">
            {pvalue.toFixed(3)}
          </span>
        </div>
        <input
          id="cmp-pvalue"
          type="range"
          min={0.001}
          max={1}
          step={0.001}
          value={pvalue}
          onChange={(e) =>
            onChange({ pvalue: clamp(Number(e.target.value), 0.001, 1) })
          }
          className="w-full"
        />
      </div>

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
