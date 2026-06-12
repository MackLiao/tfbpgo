import { useMemo } from "react";
import type { Schemas } from "@/api/client";

// Upper-triangle pairwise correlation matrix for the Binding module.
//
// Parity reference: reference/tfbpshiny/utils/correlation_matrix.py
// (build_correlation_matrix_ui) and reference/tfbpshiny/modules/binding/
// server/workspace.py (corr_matrix_container + the cell-click toggle factory).
//
// Layout (N=4 example, datasets A B C D):
//
//          B      C      D
//    A   A-B    A-C    A-D
//    B          B-C    B-D
//    C                 C-D
//
// Row labels (sticky left) identify the row dataset; column headers identify
// the column dataset. The last dataset has no row (all its cells would be
// diagonal/lower-triangle) so it appears only as a column header — exactly the
// `active_datasets[:-1]` / `active_datasets[1:]` slicing in correlation_matrix.py.
// Diagonal + lower-triangle positions are non-interactive grey placeholders.
//
// Each interactive cell[row i, col j] (i<j) shows the MEDIAN of that pair's
// per-regulator correlations. Per the task contract the median is FRONTEND-
// derived: median(pair.points.map(p => p.correlation)) over finite values,
// formatted to 3 decimals — matching correlation_matrix.py:104-110
// (`df["correlation"].median()`, `f"{med:.3f}"`, "—" when NaN/empty).
//
// Clicking an interactive cell toggles its membership in the PENDING selection
// (visual highlight only). Committing pending → the data renders happens in the
// parent route via the Execute Analysis button (workspace.py pending_pairs vs
// committed_pairs). We follow the SelectionMatrix.tsx Tailwind table pattern
// (NOT the reference's Shiny `.matrix-cell-*` CSS classes).

export interface CorrelationMatrixProps {
  resp: Schemas["CorrResponse"];
  /** Active binding dataset db_names (already the URL `?binding=` selection). */
  datasets: string[];
  datasetDisplay: (db: string) => string;
  /** Pending (highlight-only) selection, encoded as canonical `dbA__dbB` keys. */
  pendingKeys: Set<string>;
  /** Toggle a pair's pending membership; receives the canonical `dbA__dbB` key. */
  onToggle: (pairKey: string) => void;
}

// Canonical pair key: sort the two db_names so (a,b) and (b,a) collapse to the
// same identifier. Mirrors the `_canonical` rank ordering in
// correlation_matrix.py:81-82 — here, since `datasets` is sorted before use,
// lexicographic min/max is equivalent to the reference's rank ordering.
export function pairKey(a: string, b: string): string {
  return a <= b ? `${a}__${b}` : `${b}__${a}`;
}

// Median of a numeric array (finite values only). Filtering non-finite values
// before the median matches how the app treats NaN correlations (the task
// contract) and the reference's `dropna` on the correlation column.
function median(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export function CorrelationMatrix({
  resp,
  datasets,
  datasetDisplay,
  pendingKeys,
  onToggle,
}: CorrelationMatrixProps) {
  // Sorted dataset list — the matrix axis order. Mirrors workspace.py:595
  // (`sorted(active_datasets)`) so row/column placement is deterministic.
  const ordered = useMemo(() => [...datasets].sort(), [datasets]);

  // Median correlation per canonical pair key, derived client-side from the
  // /binding/corr response. Pairs not present in the response (e.g. a dataset
  // pair that produced no rows) simply have no entry and render "—".
  const medianByKey = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const pair of resp.pairs ?? []) {
      const key = pairKey(pair.dbA, pair.dbB);
      m.set(
        key,
        median(pair.points.map((p) => p.correlation)),
      );
    }
    return m;
  }, [resp.pairs]);

  // Empty state when fewer than two datasets are active — the matrix needs at
  // least one pair (workspace.py:581-587 "No active binding dataset pairs.").
  if (ordered.length < 2) {
    return (
      <div className="rounded border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-600">
        Select at least two binding datasets to see the correlation matrix.
      </div>
    );
  }

  // Header: corner spacer + column labels for datasets[1..N-1]. datasets[0]
  // appears only as a row label (its column is entirely lower-triangle /
  // diagonal). Mirrors correlation_matrix.py:89-91.
  const colDatasets = ordered.slice(1);
  // Body: one row per dataset except the last. Mirrors correlation_matrix.py:95.
  const rowDatasets = ordered.slice(0, -1);

  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-sm" data-testid="corr-matrix">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-medium text-slate-500"></th>
            {colDatasets.map((db) => (
              <th
                key={db}
                className="border border-slate-200 bg-slate-50 px-3 py-2 text-center text-xs font-medium text-slate-700"
              >
                {datasetDisplay(db)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowDatasets.map((rowDb, rowIdx) => (
            <tr key={rowDb}>
              <th
                scope="row"
                className="sticky left-0 z-10 border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-medium text-slate-700"
              >
                {datasetDisplay(rowDb)}
              </th>
              {colDatasets.map((colDb, colHeaderIdx) => {
                // colHeaderIdx is the 0-based index into `colDatasets`
                // (= ordered[1:]), so the absolute column index in `ordered` is
                // `col_i = colHeaderIdx + 1` — matching the reference's
                // `enumerate(active_datasets[1:], start=1)` (correlation_matrix.py:97).
                // The reference marks lower-triangle/diagonal cells with
                // `col_i <= row_i` (line 98), where `row_i = rowIdx`. So a cell
                // is interactive (upper-triangle) iff `col_i > row_i`, i.e.
                // `(colHeaderIdx + 1) > rowIdx` ⇒ `colHeaderIdx >= rowIdx`.
                const isUpper = colHeaderIdx >= rowIdx;
                if (!isUpper) {
                  // Diagonal or lower-triangle — non-interactive grey placeholder
                  // (correlation_matrix.py:99-100 `matrix_cell("empty")`).
                  return (
                    <td
                      key={colDb}
                      className="border border-slate-200 bg-slate-50/40 px-3 py-2 text-center text-xs text-slate-300"
                      data-testid={`corr-cell-${rowDb}-${colDb}`}
                      data-interactive="false"
                    >
                      &nbsp;
                    </td>
                  );
                }

                const key = pairKey(rowDb, colDb);
                const med = medianByKey.get(key);
                const label =
                  med === undefined || med === null ? "—" : med.toFixed(3);
                const selected = pendingKeys.has(key);
                const cellCls = selected
                  ? "border border-blue-400 bg-blue-100 px-0 py-0 text-xs"
                  : "border border-slate-200 px-0 py-0 text-xs";
                const btnCls = selected
                  ? "block w-full px-3 py-2 text-center font-mono font-semibold text-blue-900 hover:bg-blue-200"
                  : "block w-full px-3 py-2 text-center font-mono text-slate-800 hover:bg-slate-100";
                return (
                  <td
                    key={colDb}
                    className={cellCls}
                    data-testid={`corr-cell-${rowDb}-${colDb}`}
                    data-interactive="true"
                    data-selected={selected ? "true" : undefined}
                  >
                    <button
                      type="button"
                      onClick={() => onToggle(key)}
                      className={btnCls}
                      aria-pressed={selected}
                      title={
                        selected
                          ? "Click to deselect this pair"
                          : "Click to select this pair"
                      }
                    >
                      {label}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
