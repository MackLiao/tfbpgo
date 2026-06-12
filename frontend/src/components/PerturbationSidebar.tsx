// Mirrors components/BindingSidebar.tsx 1:1 for the Perturbation route.
// Keep these in sync.
import type { ReactNode } from "react";
import type { CorrMethod, MeasurementCol } from "@/api/client";
import { RegulatorPicker } from "@/components/RegulatorPicker";

// Sidebar for the Perturbation route. Mirrors
// reference/tfbpshiny/modules/perturbation/ui.py:23-49:
//   - Sidebar heading "Perturbation"
//   - Column radio (-log10(p-value) / Effect / P-value, default Effect, inline)
//     — the log10pval option was added in the 2026-06-11 parity pass (PERT-1),
//     but the perturbation module keeps effect as its default (UNLIKE binding).
//   - Correlation radio (Pearson / Spearman, default pearson, inline)
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
