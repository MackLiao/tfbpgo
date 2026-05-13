import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";

export function FilterChips(props: {
  availableDatasets: string[];
  selected: { common?: string; intersect?: string; regulators?: string[] };
  onResolved: (tags: string[]) => void;
}) {
  const [common, setCommon] = useState(props.selected.common ?? "");
  const { data, isFetching } = useQuery({
    queryKey: qk.resolve({ common }),
    queryFn: () => api.resolve(common ? { common } : {}),
    enabled: Boolean(common),
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className="rounded border px-2 py-1 text-sm"
        value={common}
        onChange={(e) => setCommon(e.target.value)}
      >
        <option value="">no compact filter</option>
        {props.availableDatasets.flatMap((a, i) =>
          props.availableDatasets.slice(i + 1).map((b) => (
            <option key={`${a}:${b}`} value={`${a}:${b}`}>{`common: ${a} ∩ ${b}`}</option>
          )),
        )}
      </select>
      {isFetching && <span className="text-xs text-slate-500">resolving…</span>}
      {data && (
        <Button size="sm" onClick={() => props.onResolved(data.regulators)}>
          apply {data.regulators.length}
          {data.truncated ? "+" : ""} tags
        </Button>
      )}
    </div>
  );
}
