// SelectionMatrix — Task B4 workspace component.
//
// Renders the intersection matrix as an HTML <table> (not Plotly — the
// values are small integers and the visual is a grid of counts, so DOM is
// the right primitive). Mirrors Shiny's `_matrix_data()` workspace from
// reference/tfbpshiny/modules/select_datasets/server/workspace.py:74-126.
//
// Diagonal cells:        "{N} regulators / {M} samples"  (row 26)
// Upper-tri off-diag:    "{N} common regulators"          (row 27) — clickable
// Lower-tri off-diag:    "—"                              (intentionally blank)

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { Skeleton } from "@/components/ui/skeleton";

export interface SelectionMatrixProps {
  datasets: string[];
  /** Raw URL `?filters=` value (already JSON-encoded string). Empty when absent. */
  filters: string;
  datasetDisplay: (db: string) => string;
  onOffDiagonalClick: (dbA: string, dbB: string) => void;
}

export function SelectionMatrix(props: SelectionMatrixProps) {
  const { datasets, filters, datasetDisplay, onOffDiagonalClick } = props;

  // Hook order must stay stable across renders — `enabled` gates the fetch
  // when there are no active datasets rather than early-returning above it.
  const { data, isLoading, isError, error } = useQuery({
    queryKey: qk.selectionMatrix(datasets, filters),
    queryFn: () =>
      filters
        ? api.selectionMatrix({ datasets, filters })
        : api.selectionMatrix({ datasets }),
    enabled: datasets.length > 0,
  });

  if (datasets.length === 0) {
    return (
      <div className="rounded border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-600">
        Select datasets from the sidebar to view sample counts.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (isError) {
    return (
      <p className="text-sm text-red-700">
        Failed to load dataset matrix. Check that filters are valid. (
        {error instanceof Error ? error.message : "unknown error"})
      </p>
    );
  }
  if (!data) return null;

  // Build lookup tables for O(1) access while rendering.
  const diag = new Map<string, { nRegulators: number; nSamples: number }>();
  for (const c of data.diagonal) {
    diag.set(c.dbName, { nRegulators: c.nRegulators, nSamples: c.nSamples });
  }
  // The server sorts the pair as (min, max), so we key by sorted pair too.
  const cross = new Map<string, { nCommon: number }>();
  for (const c of data.crossDataset) {
    const [a, b] = c.dbA <= c.dbB ? [c.dbA, c.dbB] : [c.dbB, c.dbA];
    cross.set(`${a}__${b}`, { nCommon: c.nCommon });
  }

  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-sm">
        <thead>
          <tr>
            <th className="border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-medium text-slate-500"></th>
            {datasets.map((db) => (
              <th
                key={db}
                className="border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-medium text-slate-700"
              >
                {datasetDisplay(db)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {datasets.map((rowDb, rowIdx) => (
            <tr key={rowDb}>
              <th
                scope="row"
                className="border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-medium text-slate-700"
              >
                {datasetDisplay(rowDb)}
              </th>
              {datasets.map((colDb, colIdx) => {
                if (rowDb === colDb) {
                  const d = diag.get(rowDb);
                  return (
                    <td
                      key={colDb}
                      className="border border-slate-200 bg-blue-50 px-3 py-2 font-mono text-xs text-slate-800"
                      data-testid={`cell-${rowDb}-${colDb}`}
                    >
                      {d ? (
                        <>
                          {d.nRegulators} regulators
                          <br />
                          {d.nSamples} samples
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  );
                }
                if (colIdx > rowIdx) {
                  // Upper triangle: clickable common-regulators cell.
                  const [a, b] = rowDb <= colDb ? [rowDb, colDb] : [colDb, rowDb];
                  const c = cross.get(`${a}__${b}`);
                  return (
                    <td
                      key={colDb}
                      className="border border-slate-200 px-0 py-0 text-xs"
                      data-testid={`cell-${rowDb}-${colDb}`}
                    >
                      <button
                        type="button"
                        onClick={() => onOffDiagonalClick(rowDb, colDb)}
                        className="block w-full px-3 py-2 text-left font-mono text-slate-800 hover:bg-slate-100"
                      >
                        {c ? `${c.nCommon} common regulators` : "—"}
                      </button>
                    </td>
                  );
                }
                // Lower triangle: empty (Shiny shows nothing here).
                return (
                  <td
                    key={colDb}
                    className="border border-slate-200 bg-slate-50/40 px-3 py-2 text-xs text-slate-300"
                    data-testid={`cell-${rowDb}-${colDb}`}
                  >
                    —
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
