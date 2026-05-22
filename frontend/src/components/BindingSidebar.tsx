import { RegulatorPicker } from "@/components/RegulatorPicker";

// Sidebar for the Binding route. Mirrors
// reference/tfbpshiny/modules/binding/server/sidebar.py:91-106:
//   - Sidebar heading "Binding"
//   - Column radio (Effect / P-value, default effect, inline)
//   - Correlation radio (Pearson / Spearman, default pearson, inline)
//   - Regulator picker
//
// All three control values are URL-backed in Binding.tsx
// (?col=, ?corr=, ?regulator=) so the page is fully deep-linkable.

export interface BindingSidebarProps {
  regulator: string | null;
  onRegulatorChange: (locusTag: string) => void;
  col: "effect" | "pvalue";
  method: "pearson" | "spearman";
  onColChange: (col: "effect" | "pvalue") => void;
  onMethodChange: (m: "pearson" | "spearman") => void;
}

export function BindingSidebar({
  regulator,
  onRegulatorChange,
  col,
  method,
  onColChange,
  onMethodChange,
}: BindingSidebarProps) {
  return (
    <aside className="space-y-5 rounded-md border border-slate-200 bg-white p-3 text-sm">
      <h2 className="text-lg font-semibold">Binding</h2>

      <fieldset>
        <legend className="mb-1 font-medium text-slate-700">Column</legend>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="binding-col"
              value="effect"
              checked={col === "effect"}
              onChange={() => onColChange("effect")}
            />
            <span>Effect</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="binding-col"
              value="pvalue"
              checked={col === "pvalue"}
              onChange={() => onColChange("pvalue")}
            />
            <span>P-value</span>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 font-medium text-slate-700">Correlation</legend>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="binding-corr"
              value="pearson"
              checked={method === "pearson"}
              onChange={() => onMethodChange("pearson")}
            />
            <span>Pearson</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="binding-corr"
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
        <RegulatorPicker value={regulator} onChange={onRegulatorChange} />
      </div>
    </aside>
  );
}
