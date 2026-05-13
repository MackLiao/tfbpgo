import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { RegulatorPicker } from "@/components/RegulatorPicker";
import { BindingScatter } from "@/plots/BindingScatter";
import { PlotSkeleton } from "@/components/PlotSkeleton";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export function Binding() {
  const [params, setParams] = useSearchParams();
  const reg = params.get("regulator");
  // URL state uses data-type-keyed names so Binding and Perturbation routes
  // can share a URL: ?binding=...&perturbation=...&regulator=...
  const datasets = (params.get("binding") ?? "").split(",").filter(Boolean);
  const filters = params.get("filters") ?? "";

  const { data, isPending, error } = useQuery({
    queryKey: qk.binding(reg ?? "", datasets, filters),
    queryFn: () =>
      api.binding(filters ? { regulator: reg!, datasets, filters } : { regulator: reg!, datasets }),
    enabled: Boolean(reg && datasets.length),
  });

  const setRegulator = (tag: string): void => {
    const next = new URLSearchParams(params);
    next.set("regulator", tag);
    setParams(next);
  };

  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
      <aside className="space-y-4">
        <h2 className="text-lg font-semibold">Regulator</h2>
        <RegulatorPicker value={reg} onChange={setRegulator} />
      </aside>
      <div>
        <ErrorBoundary>
          {error && <p className="text-red-600">{(error as Error).message}</p>}
          {isPending && reg && datasets.length ? <PlotSkeleton /> : null}
          {!reg || !datasets.length ? (
            <p className="text-sm text-slate-600">
              Pick a regulator on the left and select one or more binding datasets on the
              Select page to render a scatter plot.
            </p>
          ) : null}
          {data && <BindingScatter datasets={data.datasets} />}
        </ErrorBoundary>
      </div>
    </section>
  );
}
