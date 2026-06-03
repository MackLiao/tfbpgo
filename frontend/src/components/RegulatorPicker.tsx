import { useQuery } from "@tanstack/react-query";
import { useState, useDeferredValue } from "react";
import { api } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { Input } from "@/components/ui/input";

interface RegulatorPickerProps {
  value: string | null;
  onChange: (locusTag: string) => void;
}

export function RegulatorPicker({ value, onChange }: RegulatorPickerProps) {
  const [query, setQuery] = useState("");
  const dq = useDeferredValue(query);
  const { data } = useQuery({
    queryKey: qk.regulators(dq, 20),
    queryFn: ({ signal }) => api.regulators(dq ? { search: dq, limit: 20 } : { limit: 20 }, signal),
    enabled: dq.length >= 1,
  });

  return (
    <div className="space-y-2">
      <Input
        placeholder="search regulator (locus tag or symbol)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="max-h-48 overflow-y-auto rounded-md border">
        {data?.regulators.map((r) => (
          <li key={r.locusTag}>
            <button
              type="button"
              className={`w-full px-2 py-1 text-left text-sm hover:bg-slate-100 ${
                value === r.locusTag ? "bg-slate-200" : ""
              }`}
              onClick={() => onChange(r.locusTag)}
            >
              {r.displayName} <span className="text-slate-500">({r.locusTag})</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
