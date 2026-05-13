import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useAppStore } from "./store";

// Bidirectional bridge: URL → store on mount/route change, store → URL never
// (the router is canonical; views write to URL via setSearchParams).
export function useUrlBridge(): void {
  const [params] = useSearchParams();
  const setAll = useAppStore((s) => s.set);
  useEffect(() => {
    setAll({
      selectedRegulator: params.get("regulator"),
      selectedBindingDatasets: (params.get("binding") ?? "").split(",").filter(Boolean),
      selectedPerturbationDatasets: (params.get("perturbation") ?? "").split(",").filter(Boolean),
      topN: Number(params.get("top_n") ?? 25),
      effectThreshold: Number(params.get("effect") ?? 0),
      pvalueThreshold: Number(params.get("pvalue") ?? 0.05),
      filtersJson: params.get("filters") ?? "",
    });
  }, [params, setAll]);
}
