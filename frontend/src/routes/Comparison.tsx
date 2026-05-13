import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { ComparisonHeatmap } from "@/plots/ComparisonHeatmap";
import { DTOPlot } from "@/plots/DTOPlot";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";

export function Comparison() {
  const [params] = useSearchParams();
  const binding = (params.get("binding") ?? "").split(",").filter(Boolean);
  const perturbation = (params.get("perturbation") ?? "").split(",").filter(Boolean);
  const topN = Number(params.get("top_n") ?? 25);
  const effect = Number(params.get("effect") ?? 0);
  const pvalue = Number(params.get("pvalue") ?? 0.05);
  const filters = params.get("filters") ?? "";

  const [tab, setTab] = useState<string>("topn");

  const topnQuery = useQuery({
    queryKey: qk.topn(binding, perturbation, topN, effect, pvalue, filters),
    queryFn: () => {
      const base = {
        binding,
        perturbation,
        top_n: topN,
        effect,
        pvalue,
      };
      return api.topn(filters ? { ...base, filters } : base);
    },
    enabled: binding.length > 0 && perturbation.length > 0,
  });

  const dtoQuery = useQuery({
    queryKey: qk.dto(),
    queryFn: () => api.dto(),
  });

  return (
    <section className="space-y-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="topn">Top-N</TabsTrigger>
          <TabsTrigger value="dto">DTO</TabsTrigger>
        </TabsList>
        <TabsContent value="topn">
          {!binding.length || !perturbation.length ? (
            <p className="text-sm text-slate-600">
              Pick at least one binding and one perturbation dataset on the Select page to
              render the Top-N heatmap.
            </p>
          ) : null}
          {topnQuery.error ? (
            <p className="text-red-600">{(topnQuery.error as Error).message}</p>
          ) : null}
          {topnQuery.isPending && binding.length > 0 && perturbation.length > 0 ? (
            <Skeleton className="h-96 w-full" />
          ) : null}
          {topnQuery.data ? <ComparisonHeatmap resp={topnQuery.data} /> : null}
        </TabsContent>
        <TabsContent value="dto">
          {dtoQuery.error ? (
            <p className="text-red-600">{(dtoQuery.error as Error).message}</p>
          ) : null}
          {dtoQuery.isPending ? <Skeleton className="h-96 w-full" /> : null}
          {dtoQuery.data ? <DTOPlot rows={dtoQuery.data.rows} /> : null}
        </TabsContent>
      </Tabs>
    </section>
  );
}
