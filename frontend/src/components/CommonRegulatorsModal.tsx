// CommonRegulatorsModal — Task B4 off-diagonal cell flow.
//
// Scope mirrors P0 row 29 of docs/parity/select_datasets.md §2: clicking
// an off-diagonal cell opens this modal which lists the regulators common
// to both datasets and offers a "Select N common regulators" button that
// writes the locus tags back via the caller-supplied callback.
//
// Backend: GET /api/v/{v}/regulators/resolve?common=A:B. The server has
// already deduped + sorted + capped (1000) the result; we just render it.
//
// Task C5 (rows 15, 30, 31): the callback now receives the originating
// pair (display names) so the caller can attach a `fromPair` annotation
// to the resulting `regulator_locus_tag` filter. See lib/filter-spec.ts.

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export interface CommonRegulatorsModalProps {
  open: boolean;
  onClose: () => void;
  dbA: string;
  dbB: string;
  displayA: string;
  displayB: string;
  /**
   * SD-1: active dataset filters (FiltersByDB-shape JSON, scoped to the pair)
   * so the resolved common set is filter-aware — matching the filter-aware
   * matrix cell the user clicked. Empty/undefined means no active filters.
   */
  filters?: string;
  /**
   * Called when the user clicks "Select N common regulators". `tags` is
   * the locus-tag list; `pair` is `[displayA, displayB]` for the
   * `fromPair` annotation that the Select route uses to highlight the
   * originating matrix cell and to render the cleanup affordance in the
   * filter modal.
   */
  onSelectCommon: (tags: string[], pair: [string, string]) => void;
}

export function CommonRegulatorsModal(props: CommonRegulatorsModalProps) {
  const { open, onClose, dbA, dbB, displayA, displayB, filters, onSelectCommon } = props;
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
      className="w-[min(640px,90vw)] max-w-none rounded-lg p-0 backdrop:bg-slate-900/50"
    >
      {open && (
        <Body
          dbA={dbA}
          dbB={dbB}
          displayA={displayA}
          displayB={displayB}
          filters={filters ?? ""}
          onClose={onClose}
          onSelectCommon={onSelectCommon}
        />
      )}
    </dialog>
  );
}

interface BodyProps {
  dbA: string;
  dbB: string;
  displayA: string;
  displayB: string;
  filters: string;
  onClose: () => void;
  onSelectCommon: (tags: string[], pair: [string, string]) => void;
}

/**
 * Read the active `regulator_locus_tag` filter values for one dataset out of
 * the scoped `?filters=` JSON, or null when none. Used to make the modal's
 * common-regulator list consistent with the matrix cell: the cell narrows
 * `n_common` by the regulator filter (both INTERSECT arms apply it), but the
 * backend `/regulators/resolve` intentionally STRIPS regulator_locus_tag (so
 * the pairwise flow can re-derive the full common set — mirrors Shiny
 * `workspace.py:304`). When a regulator filter is active we therefore
 * intersect the resolved set with it client-side so the displayed list +
 * count + "Select N" all match the cell the user clicked.
 */
function regulatorConstraint(filtersJson: string, db: string): Set<string> | null {
  if (!filtersJson) return null;
  try {
    const obj = JSON.parse(filtersJson) as Record<string, Record<string, unknown>>;
    const spec = obj?.[db]?.["regulator_locus_tag"] as
      | { type?: string; value?: unknown }
      | undefined;
    if (spec && spec.type === "categorical" && Array.isArray(spec.value)) {
      return new Set(spec.value.filter((v): v is string => typeof v === "string"));
    }
  } catch {
    // malformed scoped filters → treat as no constraint
  }
  return null;
}

function Body({ dbA, dbB, displayA, displayB, filters, onClose, onSelectCommon }: BodyProps) {
  const common = `${dbA}:${dbB}`;
  const { data, isLoading, isError, error } = useQuery({
    queryKey: qk.regulatorsResolveCommon(dbA, dbB, filters),
    // Build the query object conditionally so `filters` is omitted (not set
    // to undefined) when empty — required under exactOptionalPropertyTypes.
    queryFn: () => api.resolve(filters ? { common, filters } : { common }),
  });

  // The resolve drops regulator_locus_tag; re-apply each side's regulator
  // constraint here so the modal matches the (regulator-filtered) cell count.
  const constraintA = regulatorConstraint(filters, dbA);
  const constraintB = regulatorConstraint(filters, dbB);
  const tags = (data?.regulators ?? []).filter(
    (t) => (!constraintA || constraintA.has(t)) && (!constraintB || constraintB.has(t)),
  );
  const truncated = data?.truncated === true;

  return (
    <div className="flex max-h-[80vh] flex-col">
      <header className="border-b border-slate-200 px-5 py-3">
        <h2 className="text-lg font-semibold text-slate-900">Common regulators</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          {displayA} <span aria-hidden>∩</span> {displayB}
        </p>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
        {isError && (
          <p className="text-sm text-red-700">
            Failed to load common regulators:{" "}
            {error instanceof Error ? error.message : "unknown error"}
          </p>
        )}
        {data && (
          <>
            <p className="mb-2 text-sm text-slate-700">
              <span className="font-mono">{tags.length}</span> common regulators
              {truncated ? " (truncated)" : ""}.
            </p>
            {tags.length === 0 ? (
              <p className="text-sm text-slate-500">No common regulators.</p>
            ) : (
              <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 sm:grid-cols-3 md:grid-cols-4">
                {tags.map((t) => (
                  <li key={t} className="truncate font-mono text-xs text-slate-700">
                    {t}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
        <Button onClick={onClose}>Close</Button>
        <Button
          disabled={tags.length === 0}
          onClick={() => {
            onSelectCommon(tags, [displayA, displayB]);
            onClose();
          }}
          className="border-blue-600 bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-300 disabled:text-slate-500"
        >
          Select {tags.length} common regulators
        </Button>
      </footer>
    </div>
  );
}
