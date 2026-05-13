import { getArtifactVersion } from "@/api/client";

// Bake artifactVersion into every key so the cache is purged when the
// artifact rolls (mirrors the backend cache key strategy).
const v = (): string => getArtifactVersion();

export const qk = {
  datasets: () => [v(), "datasets"] as const,
  regulators: (search: string, limit: number) => [v(), "regulators", search, limit] as const,
  resolve: (q: { common?: string; intersect?: string; regulators?: string[] }) =>
    [v(), "resolve", q.common ?? "", q.intersect ?? "", (q.regulators ?? []).join(",")] as const,
  binding: (regulator: string, datasets: string[], filters: string) =>
    [v(), "binding", regulator, datasets.join(","), filters] as const,
  perturbation: (regulator: string, datasets: string[], filters: string) =>
    [v(), "perturbation", regulator, datasets.join(","), filters] as const,
  topn: (b: string[], p: string[], topN: number, eff: number, pv: number, filters: string) =>
    [v(), "topn", b.join(","), p.join(","), topN, eff, pv, filters] as const,
  dto: () => [v(), "dto"] as const,
};
