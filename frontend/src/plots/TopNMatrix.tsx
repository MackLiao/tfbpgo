import { useMemo } from "react";
import type { Schemas } from "@/api/client";

// Rectangular binding(rows) × perturbation(cols) responsive-ratio matrix for the
// Comparison module's "Compare Datasets" tab.
//
// Parity reference:
//   reference/tfbpshiny/utils/topn_matrix.py  (build_topn_matrix_ui — the
//     corner-spacer + perturbation column headers + per-binding rows layout;
//     clickable row headers / column headers / interior cells)
//   reference/tfbpshiny/modules/comparison/server/workspace.py:1175-1299
//     (the row/col/cell selection effects + the per-cell median render).
//
// Layout (binding rows B, perturbation cols P):
//
//              Pert A    Pert B    Pert C
//    Bind X    12.3%     —         8.7%
//    Bind Y    15.1%     9.4%      11.0%
//
// Click semantics (workspace.py:1175-1207):
//   - Row header  → select that BINDING dataset (clears any perturbation sel).
//   - Col header  → select that PERTURBATION dataset (clears any binding sel).
//   - Interior cell → select that cell's BINDING dataset (matches the reference
//     `_on_cell` which sets cd_selected_binding=b_db, cd_selected_perturbation
//     =None — a cell click drills into the binding ROW, NOT a single pair). A
//     cell renders "active" when its row OR its column is the current selection.
//
// Cell value (workspace.py:1228-1235): the MEDIAN of per-regulator medians of
// percent-responsive. We compute it client-side from the topn rows of that
// (binding, perturbation) pair:
//   1. group the pair's rows by regulatorLocusTag,
//   2. take median(responsiveRatio) within each regulator group,
//   3. take the median of those per-regulator medians,
//   4. ×100 and format as an integer percent ("42%"); "—" when no rows.
// (responsiveRatio is already a 0..1 ratio; percent_responsive in the reference
// is responsive_ratio*100 — workspace.py:193.)
//
// We follow the SelectionMatrix/CorrelationMatrix Tailwind table pattern (NOT
// the reference's Shiny `.matrix-cell-*` CSS classes).

export interface TopNMatrixSelection {
  /** Selected binding db_name, or null. Mutually exclusive with perturbation. */
  binding: string | null;
  /** Selected perturbation db_name, or null. */
  perturbation: string | null;
}

export interface TopNMatrixProps {
  resp: Schemas["TopNResponse"];
  /** Active binding dataset db_names (rows), in display order. */
  bindingDatasets: string[];
  /** Active perturbation dataset db_names (columns), in display order. */
  perturbationDatasets: string[];
  /** db_name → display label (falls back to the label maps / db_name). */
  displayName: (db: string) => string;
  selection: TopNMatrixSelection;
  /** Select a whole binding row. */
  onSelectBinding: (db: string) => void;
  /** Select a whole perturbation column. */
  onSelectPerturbation: (db: string) => void;
}

// Median of a numeric array (finite values only). Matches the reference's
// pandas `.median()` which drops NaN (workspace.py:1231-1232).
function median(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

// Two-stage median-of-per-regulator-medians for one pair's rows, returned as a
// percent (0..100) or null when the pair has no usable rows. Mirrors
// workspace.py:1231-1233 exactly:
//   per_reg = sub.groupby("regulator_locus_tag")["percent_responsive"].median()
//   val = float(per_reg.median())
// Exported so the Compare Promoter Definitions / Compare Analysis Methods tables
// (PromoterDefinitionsTable / AnalysisMethodsTable) compute their cells with the
// IDENTICAL two-stage median — never re-derive this. The reference uses the same
// `groupby(regulator).median().median()` for the matrix cells (workspace.py:
// 1231-1233) and both variant tables (1469-1472 cp, 1618-1621 cm).
export function cellPercent(rows: Schemas["TopNRow"][]): number | null {
  if (rows.length === 0) return null;
  const byReg = new Map<string, number[]>();
  for (const r of rows) {
    let arr = byReg.get(r.regulatorLocusTag);
    if (!arr) {
      arr = [];
      byReg.set(r.regulatorLocusTag, arr);
    }
    // responsiveRatio is 0..1; scale to percent to match percent_responsive.
    arr.push(r.responsiveRatio * 100);
  }
  const perRegMedians: number[] = [];
  for (const vals of byReg.values()) {
    const m = median(vals);
    if (m !== null) perRegMedians.push(m);
  }
  return median(perRegMedians);
}

export function TopNMatrix({
  resp,
  bindingDatasets,
  perturbationDatasets,
  displayName,
  selection,
  onSelectBinding,
  onSelectPerturbation,
}: TopNMatrixProps) {
  // Index the topn rows by their pair_key ("{bindingDB}__{perturbationDB}") so
  // each cell can pull its slice without rescanning the full row list. The
  // backend emits pairKey on every TopNRow (generated.ts TopNRow.pairKey).
  const rowsByPair = useMemo(() => {
    const m = new Map<string, Schemas["TopNRow"][]>();
    for (const r of resp.rows ?? []) {
      let arr = m.get(r.pairKey);
      if (!arr) {
        arr = [];
        m.set(r.pairKey, arr);
      }
      arr.push(r);
    }
    return m;
  }, [resp.rows]);

  // Precompute every cell's percent once. Keyed by the same pair_key.
  const percentByPair = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const b of bindingDatasets) {
      for (const p of perturbationDatasets) {
        const key = `${b}__${p}`;
        m.set(key, cellPercent(rowsByPair.get(key) ?? []));
      }
    }
    return m;
  }, [rowsByPair, bindingDatasets, perturbationDatasets]);

  if (bindingDatasets.length === 0 || perturbationDatasets.length === 0) {
    return (
      <div className="rounded border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-600">
        Select at least one binding and one perturbation dataset to see the
        comparison matrix.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-sm" data-testid="topn-matrix">
        <thead>
          <tr>
            {/* Corner spacer — topn_matrix.py:76 matrix_header_cell("", row). */}
            <th className="sticky left-0 z-10 border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-medium text-slate-500"></th>
            {perturbationDatasets.map((p) => {
              const active = selection.perturbation === p;
              return (
                <th
                  key={p}
                  className="border border-slate-200 bg-slate-50 p-0 text-center text-xs font-medium"
                  data-testid={`topn-col-${p}`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectPerturbation(p)}
                    aria-pressed={active}
                    title="Click to view distributions for this perturbation dataset"
                    className={
                      active
                        ? "block w-full px-3 py-2 font-semibold text-white"
                        : "block w-full px-3 py-2 text-slate-700 hover:bg-slate-100"
                    }
                    style={active ? { backgroundColor: "#2B4C7E" } : undefined}
                  >
                    {displayName(p)}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {bindingDatasets.map((b) => {
            const rowActive = selection.binding === b;
            return (
              <tr key={b}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border border-slate-200 bg-slate-50 p-0 text-left text-xs font-medium"
                  data-testid={`topn-row-${b}`}
                  data-selected={rowActive ? "true" : undefined}
                >
                  <button
                    type="button"
                    onClick={() => onSelectBinding(b)}
                    aria-pressed={rowActive}
                    title="Click to view distributions for this binding dataset"
                    className={
                      rowActive
                        ? "block w-full whitespace-nowrap px-3 py-2 font-semibold text-white"
                        : "block w-full whitespace-nowrap px-3 py-2 text-slate-700 hover:bg-slate-100"
                    }
                    style={rowActive ? { backgroundColor: "#2B4C7E" } : undefined}
                  >
                    {displayName(b)}
                  </button>
                </th>
                {perturbationDatasets.map((p) => {
                  const key = `${b}__${p}`;
                  const pct = percentByPair.get(key);
                  // Cell is active when its row OR its column is selected
                  // (topn_matrix.py:121).
                  const cellActive =
                    selection.binding === b || selection.perturbation === p;
                  const label =
                    pct === undefined || pct === null
                      ? "—"
                      : `${Math.round(pct)}%`;
                  const cellCls = cellActive
                    ? "border border-blue-400 bg-blue-100 p-0 text-xs"
                    : "border border-slate-200 p-0 text-xs";
                  const btnCls = cellActive
                    ? "block w-full px-3 py-2 text-right font-mono font-semibold text-blue-900 hover:bg-blue-200"
                    : "block w-full px-3 py-2 text-right font-mono text-slate-800 hover:bg-slate-100";
                  return (
                    <td
                      key={p}
                      className={cellCls}
                      data-testid={`topn-cell-${b}-${p}`}
                      data-selected={cellActive ? "true" : undefined}
                    >
                      <button
                        type="button"
                        // A cell click drills into the binding ROW (reference
                        // _on_cell: cd_selected_binding=b, perturbation=None).
                        onClick={() => onSelectBinding(b)}
                        // a11y parity with the row/col header buttons: announce
                        // the pair + value and reflect the row/column selection.
                        aria-pressed={cellActive}
                        aria-label={`${displayName(b)} × ${displayName(p)}: ${label}`}
                        title="Click to view distributions for this binding dataset"
                        className={btnCls}
                      >
                        {label}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
