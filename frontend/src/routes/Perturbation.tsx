import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { RegulatorPicker } from "@/components/RegulatorPicker";
import { PerturbationVolcano } from "@/plots/PerturbationVolcano";
import { PlotSkeleton } from "@/components/PlotSkeleton";

export function Perturbation() {
  const [params, setParams] = useSearchParams();
  const reg = params.get("regulator");
  const datasets = (params.get("datasets") ?? "").split(",").filter(Boolean);
  const filters = params.get("filters") ?? "";

  const { data, isPending, error } = useQuery({
    queryKey: qk.perturbation(reg ?? "", datasets, filters),
    queryFn: () =>
      api.perturbation(
        filters ? { regulator: reg!, datasets, filters } : { regulator: reg!, datasets },
      ),
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
        {error && <p className="text-red-600">{(error as Error).message}</p>}
        {isPending && reg && datasets.length ? <PlotSkeleton /> : null}
        {!reg || !datasets.length ? (
          <p className="text-sm text-slate-600">
            Pick a regulator on the left and select one or more perturbation datasets on
            the Select page to render a volcano plot.
          </p>
        ) : null}
        {data && <PerturbationVolcano datasets={data.datasets} />}
      </div>
    </section>
  );
}
