// DatasetBreakdownModal — Task C4 diagonal-cell breakdown flow.
//
// Scope: audit row 28 of docs/parity/select_datasets.md §2. Clicking a
// diagonal cell of the selection matrix opens this modal, which explains
// the regulator→sample multiplicity in the active filter context. Backend
// already exposes `/api/v/{v}/selection/breakdown` (Phase A5).
//
// Empty state copy mirrors Shiny's
// `reference/tfbpshiny/modules/select_datasets/server/workspace.py` — when
// `nMulti === 0` every regulator maps to exactly one sample.
//
// Modeled after CommonRegulatorsModal so the dialog ergonomics stay
// uniform (native <dialog>, ESC closes, backdrop dims).
//
// Cache key shape: `(db, filtersRaw)` — `filtersRaw` is the URL `?filters=`
// JSON string already used by SelectionMatrix, so the query coalesces
// with whatever the user has staged.

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, getArtifactVersion } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export interface DatasetBreakdownModalProps {
  open: boolean;
  onClose: () => void;
  db: string;
  displayName: string;
  /** Raw URL `?filters=` JSON string (forwarded verbatim to the API). */
  filters: string;
}

export function DatasetBreakdownModal(props: DatasetBreakdownModalProps) {
  const { open, onClose, db, displayName, filters } = props;
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onCancel={onClose}
      className="w-[min(560px,90vw)] max-w-none rounded-lg p-0 backdrop:bg-slate-900/50"
    >
      {open && (
        <Body
          db={db}
          displayName={displayName}
          filters={filters}
          onClose={onClose}
        />
      )}
    </dialog>
  );
}

interface BodyProps {
  db: string;
  displayName: string;
  filters: string;
  onClose: () => void;
}

function Body({ db, displayName, filters, onClose }: BodyProps) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: [getArtifactVersion(), "selectionBreakdown", db, filters] as const,
    queryFn: ({ signal }) =>
      filters
        ? api.selectionBreakdown({ dataset: db, filters }, signal)
        : api.selectionBreakdown({ dataset: db }, signal),
  });

  const nMulti = data?.nMulti ?? 0;
  // Render only columns that actually differentiate the multi-sample subset.
  const cols = (data?.columns ?? []).filter((c) => c.distinctValues > 1);

  return (
    <div className="flex max-h-[80vh] flex-col">
      <header className="border-b border-slate-200 px-5 py-3">
        <h2 className="text-lg font-semibold text-slate-900">
          Sample breakdown — {displayName}
        </h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Why some regulators appear in more than one sample.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
        {isError && (
          <p className="text-sm text-red-700">
            Failed to load breakdown:{" "}
            {error instanceof Error ? error.message : "unknown error"}
          </p>
        )}
        {data && nMulti === 0 && (
          <p className="text-sm text-slate-700">
            Every regulator maps to exactly one sample.
          </p>
        )}
        {data && nMulti > 0 && (
          <>
            <p className="mb-2 text-sm text-slate-700">
              <span className="font-mono">{nMulti}</span> regulators have
              multiple samples in {displayName}.
            </p>
            {cols.length === 0 ? (
              <p className="text-sm text-slate-500">
                None of the recorded columns differentiate these regulators.
              </p>
            ) : (
              <>
                <p className="mb-1 text-sm text-slate-700">Differs by:</p>
                <ul className="space-y-0.5">
                  {cols.map((c) => (
                    <li
                      key={c.field}
                      className="text-sm text-slate-700"
                      data-testid={`breakdown-col-${c.field}`}
                    >
                      <span className="font-mono">{c.field}</span> (
                      {c.distinctValues} values)
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
        <Button onClick={onClose}>Close</Button>
      </footer>
    </div>
  );
}
