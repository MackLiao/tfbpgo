// CommonRegulatorsModal — Task B4 off-diagonal cell flow.
//
// Scope mirrors P0 row 29 of docs/parity/select_datasets.md §2: clicking
// an off-diagonal cell opens this modal which lists the regulators common
// to both datasets and offers a "Select N common regulators" button that
// writes the locus tags to the caller-supplied URL key.
//
// Backend: GET /api/v/{v}/regulators/resolve?common=A:B. The server has
// already deduped + sorted + capped (1000) the result; we just render it.

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
  onSelectCommon: (tags: string[]) => void;
}

export function CommonRegulatorsModal(props: CommonRegulatorsModalProps) {
  const { open, onClose, dbA, dbB, displayA, displayB, onSelectCommon } = props;
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
  onClose: () => void;
  onSelectCommon: (tags: string[]) => void;
}

function Body({ dbA, dbB, displayA, displayB, onClose, onSelectCommon }: BodyProps) {
  const common = `${dbA}:${dbB}`;
  const { data, isLoading, isError, error } = useQuery({
    queryKey: qk.regulatorsResolveCommon(dbA, dbB),
    queryFn: () => api.resolve({ common }),
  });

  const tags = data?.regulators ?? [];
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
            onSelectCommon(tags);
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
