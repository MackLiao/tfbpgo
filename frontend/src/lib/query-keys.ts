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
  topn: (b: string[], p: string[], topN: number, preset: string, filters: string) =>
    [v(), "topn", b.join(","), p.join(","), topN, preset, filters] as const,
  // One /comparison/topn slice per perturbation dataset for the variant tabs
  // (Compare Promoter Definitions / Compare Analysis Methods). Each slice fires
  // [all binding variant dbs] × [a single perturbation] so each request stays
  // under the backend's 12-pair cap — mirroring the reference's per-perturbation
  // `_slice_queue` batching (workspace.py:894-908, 922-937). `tab` namespaces the
  // promoter vs. methods slices so they never collide in the query cache.
  topnSlice: (
    tab: string,
    bindings: string[],
    perturbation: string,
    topN: number,
    preset: string,
    filters: string,
  ) =>
    [
      v(),
      "topnSlice",
      tab,
      bindings.join(","),
      perturbation,
      topN,
      preset,
      filters,
    ] as const,
  dto: () => [v(), "dto"] as const,

  // ----- Select Datasets (Task B4) ---------------------------------------
  // datasets are sorted into the matrix key so cache hits survive param-order
  // permutation (mirrors qk.bindingCorr / qk.perturbationCorrelations).
  selectionMatrix: (datasets: string[], filters: string) =>
    [v(), "selectionMatrix", [...datasets].sort().join(","), filters] as const,
  datasetFields: (db: string) => [v(), "datasetFields", db] as const,
  datasetRegulators: (db: string) => [v(), "datasetRegulators", db] as const,
  // Per-dataset sample-conditions map for Binding/Perturbation overlay hovertext.
  sampleConditions: (db: string) => [v(), "sampleConditions", db] as const,
  // Pair is sorted into the key so /regulators/resolve?common=A:B and B:A
  // share a cache entry (the server is order-symmetric for intersect anyway).
  regulatorsResolveCommon: (dbA: string, dbB: string, filters = "") => {
    const [a, b] = dbA <= dbB ? [dbA, dbB] : [dbB, dbA];
    // SD-1: filters participate in the key so a filter-aware resolve never
    // reuses an unfiltered cache entry.
    return [v(), "regulatorsResolveCommon", a, b, filters] as const;
  },
};
