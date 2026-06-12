// Mirrors components/BindingSidebar.tsx 1:1 for the Perturbation route.
// Keep these in sync.
import type { ReactNode } from "react";
import type { CorrMethod, MeasurementCol } from "@/api/client";
import { RegulatorPicker } from "@/components/RegulatorPicker";

// Sidebar for the Perturbation route. Mirrors
// reference/tfbpshiny/modules/perturbation/server/sidebar.py:75-105:
//   - Sidebar heading "Perturbation"
//   - Column radio (Effect / P-value / -log10(p-value), default -log10(p-value),
//     inline) — the log10pval option + new default added in the 2026-06-11
//     parity pass (PERT-1).
//   - Correlation radio (Pearson / Spearman, default spearman, inline)
//   - Regulator picker
//
// All three control values are URL-backed in Perturbation.tsx
// (?col=, ?corr=, ?regulator=) so the page is fully deep-linkable.

export interface PerturbationSidebarProps {
  regulator: string | null;
  onRegulatorChange: (locusTag: string) => void;
  col: MeasurementCol;
  method: CorrMethod;
  onColChange: (col: MeasurementCol) => void;
  onMethodChange: (m: CorrMethod) => void;
  // See BindingSidebar — optional narrowed picker shown once the corr
  // response is loaded.
  regulatorPickerSlot?: ReactNode;
}

export function PerturbationSidebar({
  regulator,
  onRegulatorChange,
  col,
  method,
  onColChange,
  onMethodChange,
  regulatorPickerSlot,
}: PerturbationSidebarProps) {
  return (
    <aside className="space-y-5 rounded-md border border-slate-200 bg-white p-3 text-sm">
      <h2 className="text-lg font-semibold">Perturbation</h2>

      <fieldset>
        <legend className="mb-1 font-medium text-slate-700">Column</legend>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="perturbation-col"
              value="effect"
              checked={col === "effect"}
              onChange={() => onColChange("effect")}
            />
            <span>Effect</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="perturbation-col"
              value="pvalue"
              checked={col === "pvalue"}
              onChange={() => onColChange("pvalue")}
            />
            <span>P-value</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="perturbation-col"
              value="log10pval"
              checked={col === "log10pval"}
              onChange={() => onColChange("log10pval")}
            />
            <span>-log10(p-value)</span>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 font-medium text-slate-700">Correlation</legend>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="perturbation-corr"
              value="pearson"
              checked={method === "pearson"}
              onChange={() => onMethodChange("pearson")}
            />
            <span>Pearson</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="perturbation-corr"
              value="spearman"
              checked={method === "spearman"}
              onChange={() => onMethodChange("spearman")}
            />
            <span>Spearman</span>
          </label>
        </div>
      </fieldset>

      <div>
        <h3 className="mb-1 font-medium text-slate-700">Regulator</h3>
        {regulatorPickerSlot ?? (
          <RegulatorPicker value={regulator} onChange={onRegulatorChange} />
        )}
      </div>
    </aside>
  );
}
