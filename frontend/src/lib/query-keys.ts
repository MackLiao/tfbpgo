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
  // Binding correlation distribution across all sorted(datasets) choose 2 pairs.
  // Datasets are sorted into the key so cache hits survive param-order permutation.
  bindingCorr: (
    datasets: string[],
    method: string,
    col: string,
    filters: string,
  ) => [v(), "bindingCorr", [...datasets].sort().join(","), method, col, filters] as const,
  // One key per (regulator, sorted pair, method, col, filters) — TanStack
  // Query coalesces concurrent identical fetches at this granularity.
  bindingScatter: (
    regulator: string,
    pair: readonly [string, string],
    method: string,
    col: string,
    filters: string,
  ) => {
    const [a, b] = pair[0] <= pair[1] ? [pair[0], pair[1]] : [pair[1], pair[0]];
    return [v(), "bindingScatter", regulator, a, b, method, col, filters] as const;
  },
  perturbation: (regulator: string, datasets: string[], filters: string) =>
    [v(), "perturbation", regulator, datasets.join(","), filters] as const,
  // Perturbation correlation distribution across all sorted(datasets) choose 2 pairs.
  // Mirrors `bindingCorr`; datasets are sorted into the key so cache hits survive
  // param-order permutation.
  perturbationCorrelations: (
    datasets: string[],
    method: string,
    col: string,
    filters: string,
  ) =>
    [v(), "perturbationCorrelations", [...datasets].sort().join(","), method, col, filters] as const,
  // One key per (regulator, sorted pair, method, col, filters). Mirrors
  // `bindingScatter`.
  perturbationScatter: (
    regulator: string,
    pair: readonly [string, string],
    method: string,
    col: string,
    filters: string,
  ) => {
    const [a, b] = pair[0] <= pair[1] ? [pair[0], pair[1]] : [pair[1], pair[0]];
    return [v(), "perturbationScatter", regulator, a, b, method, col, filters] as const;
  },
  topn: (b: string[], p: string[], topN: number, eff: number, pv: number, filters: string) =>
    [v(), "topn", b.join(","), p.join(","), topN, eff, pv, filters] as const,
  dto: () => [v(), "dto"] as const,
};
