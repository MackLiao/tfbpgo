import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Schemas } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";

type DatasetEntry = Schemas["DatasetEntry"];

function parseCsv(value: string | null): string[] {
  return (value ?? "").split(",").filter(Boolean);
}

function toggleMembership(list: string[], item: string, checked: boolean): string[] {
  const set = new Set(list);
  if (checked) set.add(item);
  else set.delete(item);
  return [...set];
}

interface DatasetSectionProps {
  title: string;
  datasets: DatasetEntry[];
  selected: string[];
  paramKey: "binding" | "perturbation";
}

function DatasetSection({ title, datasets, selected, paramKey }: DatasetSectionProps) {
  const [params, setParams] = useSearchParams();

  if (datasets.length === 0) {
    return (
      <section>
        <h2 className="mb-3 text-xl font-semibold">{title}</h2>
        <p className="text-sm text-slate-600">No {title.toLowerCase()} datasets available.</p>
      </section>
    );
  }

  const onToggle = (dbName: string, checked: boolean): void => {
    const next = toggleMembership(selected, dbName, checked);
    const nextParams = new URLSearchParams(params);
    if (next.length === 0) nextParams.delete(paramKey);
    else nextParams.set(paramKey, next.join(","));
    setParams(nextParams, { replace: false });
  };

  return (
    <section>
      <h2 className="mb-3 text-xl font-semibold">{title}</h2>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {datasets.map((d) => {
          const checked = selected.includes(d.dbName);
          const inputId = `ds-${paramKey}-${d.dbName}`;
          return (
            <li key={d.dbName}>
              <Card>
                <CardHeader>
                  <CardTitle>
                    <label htmlFor={inputId} className="flex items-start gap-2 cursor-pointer">
                      <Checkbox
                        id={inputId}
                        className="mt-1"
                        checked={checked}
                        onChange={(e) => onToggle(d.dbName, e.currentTarget.checked)}
                      />
                      <span>{d.displayName}</span>
                    </label>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-slate-700">
                    <dt className="font-medium">db_name</dt>
                    <dd className="font-mono">{d.dbName}</dd>
                    <dt className="font-medium">assay</dt>
                    <dd>{d.assay}</dd>
                    <dt className="font-medium">source</dt>
                    <dd className="break-all">{d.sourceRepo}</dd>
                    <dt className="font-medium">sample id</dt>
                    <dd className="font-mono">{d.sampleIdField}</dd>
                  </dl>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-slate-600 hover:text-slate-900">
                      Fields ({d.fields.length})
                    </summary>
                    <ul className="mt-2 flex flex-wrap gap-1">
                      {d.fields.map((f) => (
                        <li
                          key={f}
                          className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700"
                        >
                          {f}
                        </li>
                      ))}
                    </ul>
                  </details>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function Select() {
  const [params] = useSearchParams();
  const selectedBinding = useMemo(() => parseCsv(params.get("binding")), [params]);
  const selectedPerturbation = useMemo(() => parseCsv(params.get("perturbation")), [params]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: qk.datasets(),
    queryFn: () => api.datasets(),
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Select Datasets</h1>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Select Datasets</h1>
        <p className="text-sm text-red-700">
          Failed to load datasets: {error instanceof Error ? error.message : "unknown error"}
        </p>
      </div>
    );
  }

  const datasets = data?.datasets ?? [];
  const binding = datasets.filter((d) => d.dataType === "binding");
  const perturbation = datasets.filter((d) => d.dataType === "perturbation");

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Select Datasets</h1>
        <p className="mt-1 text-sm text-slate-600">
          Toggle datasets below to include them in the Binding, Perturbation, and Comparison
          views. Your selection is stored in the URL and is deep-linkable.
        </p>
      </header>
      <DatasetSection
        title="Binding"
        datasets={binding}
        selected={selectedBinding}
        paramKey="binding"
      />
      <DatasetSection
        title="Perturbation"
        datasets={perturbation}
        selected={selectedPerturbation}
        paramKey="perturbation"
      />
    </div>
  );
}
