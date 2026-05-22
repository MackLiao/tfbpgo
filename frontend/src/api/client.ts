import type { components } from "./generated";

export type Schemas = components["schemas"];

let artifactVersion: string | null = null;

export function setArtifactVersion(v: string): void {
  artifactVersion = v;
}

export function getArtifactVersion(): string {
  if (!artifactVersion) throw new Error("artifact version not loaded yet");
  return artifactVersion;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

async function get<T>(path: string, search?: URLSearchParams): Promise<T> {
  const url = path + (search && [...search].length ? `?${search.toString()}` : "");
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 410) {
    // /api/version itself cannot legitimately return 410 (it has no artifact
    // version gate). If it does, refuse to recurse — we'd reload forever.
    if (path === "/api/version") {
      throw new ApiError(
        410,
        "stale artifact version on /api/version (should not happen)",
      );
    }
    // Guard against an infinite reload loop. Track attempts in sessionStorage
    // so a misconfigured server can't trap the user in a refresh cycle.
    const attempts = Number(sessionStorage.getItem("stale_reload_attempts") ?? "0");
    if (attempts >= 2) {
      throw new ApiError(
        410,
        "artifact version still stale after reload; refusing to loop",
      );
    }
    sessionStorage.setItem("stale_reload_attempts", String(attempts + 1));
    await refreshArtifactVersion();
    window.location.reload();
    return new Promise<T>(() => {}); // never resolves
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body);
  }
  // Any successful response clears the reload-attempt counter so a future
  // genuine 410 starts fresh.
  try {
    sessionStorage.removeItem("stale_reload_attempts");
  } catch {
    // sessionStorage may be unavailable in some test/embedded environments.
  }
  return (await res.json()) as T;
}

export async function refreshArtifactVersion(): Promise<string> {
  const v = await get<Schemas["VersionInfo"]>("/api/version");
  setArtifactVersion(v.artifactVersion);
  return v.artifactVersion;
}

function vpath(suffix: string): string {
  return `/api/v/${getArtifactVersion()}${suffix}`;
}

export const api = {
  version: (): Promise<Schemas["VersionInfo"]> => get<Schemas["VersionInfo"]>("/api/version"),
  datasets: (): Promise<Schemas["DatasetsResponse"]> =>
    get<Schemas["DatasetsResponse"]>(vpath("/datasets")),
  regulators: (q: { search?: string; limit?: number }): Promise<Schemas["RegulatorsResponse"]> => {
    const s = new URLSearchParams();
    if (q.search) s.set("search", q.search);
    if (q.limit) s.set("limit", String(q.limit));
    return get<Schemas["RegulatorsResponse"]>(vpath("/regulators"), s);
  },
  resolve: (q: {
    common?: string;
    intersect?: string;
    regulators?: string[];
  }): Promise<Schemas["ResolveResponse"]> => {
    const s = new URLSearchParams();
    if (q.common) s.set("common", q.common);
    if (q.intersect) s.set("intersect", q.intersect);
    if (q.regulators && q.regulators.length) s.set("regulators", q.regulators.join(","));
    return get<Schemas["ResolveResponse"]>(vpath("/regulators/resolve"), s);
  },
  binding: (q: {
    regulator: string;
    datasets: string[];
    filters?: string;
  }): Promise<Schemas["BindingResponse"]> => {
    const s = new URLSearchParams({ regulator: q.regulator, datasets: q.datasets.join(",") });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["BindingResponse"]>(vpath("/binding"), s);
  },
  perturbation: (q: {
    regulator: string;
    datasets: string[];
    filters?: string;
  }): Promise<Schemas["PerturbationResponse"]> => {
    const s = new URLSearchParams({ regulator: q.regulator, datasets: q.datasets.join(",") });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["PerturbationResponse"]>(vpath("/perturbation"), s);
  },
  topn: (q: {
    binding: string[];
    perturbation: string[];
    top_n?: number;
    effect?: number;
    pvalue?: number;
    filters?: string;
  }): Promise<Schemas["TopNResponse"]> => {
    const s = new URLSearchParams({
      binding: q.binding.join(","),
      perturbation: q.perturbation.join(","),
    });
    if (q.top_n) s.set("top_n", String(q.top_n));
    if (q.effect !== undefined) s.set("effect", String(q.effect));
    if (q.pvalue !== undefined) s.set("pvalue", String(q.pvalue));
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["TopNResponse"]>(vpath("/comparison/topn"), s);
  },
  // `api.dto` is intentionally unconsumed on the frontend (DTO tab removed
  // in Task B1 — Shiny has no equivalent; see docs/parity/comparison.md §2
  // row 18). Backend endpoint is preserved for future use.
  dto: (): Promise<Schemas["DTOResponse"]> => get<Schemas["DTOResponse"]>(vpath("/comparison/dto")),

  // ----- Correlation endpoints (Phase A3) ---------------------------------
  // Backend handlers: /api/v/{v}/{binding|perturbation}/{corr|correlations|scatter}.
  // The naming asymmetry — `corr` on the binding side, `correlations` (plural)
  // on the perturbation side — matches the Shiny module names captured in
  // docs/parity/{binding,perturbation}.md and is intentional.
  bindingCorr: (q: {
    datasets: string[];
    method: "pearson" | "spearman";
    col: "effect" | "pvalue";
    filters?: string;
  }): Promise<Schemas["CorrResponse"]> => {
    const s = new URLSearchParams({
      datasets: q.datasets.join(","),
      method: q.method,
      col: q.col,
    });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["CorrResponse"]>(vpath("/binding/corr"), s);
  },
  bindingScatter: (q: {
    regulator: string;
    pair: [string, string];
    method: "pearson" | "spearman";
    col: "effect" | "pvalue";
    filters?: string;
  }): Promise<Schemas["ScatterResponse"]> => {
    const s = new URLSearchParams({
      regulator: q.regulator,
      pair: q.pair.join(","),
      method: q.method,
      col: q.col,
    });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["ScatterResponse"]>(vpath("/binding/scatter"), s);
  },
  perturbationCorrelations: (q: {
    datasets: string[];
    method: "pearson" | "spearman";
    col: "effect" | "pvalue";
    filters?: string;
  }): Promise<Schemas["CorrResponse"]> => {
    const s = new URLSearchParams({
      datasets: q.datasets.join(","),
      method: q.method,
      col: q.col,
    });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["CorrResponse"]>(vpath("/perturbation/correlations"), s);
  },
  perturbationScatter: (q: {
    regulator: string;
    pair: [string, string];
    method: "pearson" | "spearman";
    col: "effect" | "pvalue";
    filters?: string;
  }): Promise<Schemas["ScatterResponse"]> => {
    const s = new URLSearchParams({
      regulator: q.regulator,
      pair: q.pair.join(","),
      method: q.method,
      col: q.col,
    });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["ScatterResponse"]>(vpath("/perturbation/scatter"), s);
  },

  // ----- Select Datasets endpoints (Phase A5) -----------------------------
  // Backend handlers: /api/v/{v}/datasets/{db}/{fields,regulators} and
  // /api/v/{v}/selection/{matrix,breakdown}. Consumed by the Phase-B Select
  // Datasets rebuild (Task B4); not wired into any UI yet.
  datasetFields: (q: { db: string }): Promise<Schemas["DatasetFieldsResponse"]> =>
    get<Schemas["DatasetFieldsResponse"]>(vpath(`/datasets/${encodeURIComponent(q.db)}/fields`)),
  datasetRegulators: (q: { db: string }): Promise<Schemas["DatasetRegulatorsResponse"]> =>
    get<Schemas["DatasetRegulatorsResponse"]>(
      vpath(`/datasets/${encodeURIComponent(q.db)}/regulators`),
    ),
  selectionMatrix: (q: {
    datasets: string[];
    filters?: string;
  }): Promise<Schemas["MatrixResponse"]> => {
    const s = new URLSearchParams({ datasets: q.datasets.join(",") });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["MatrixResponse"]>(vpath("/selection/matrix"), s);
  },
  selectionBreakdown: (q: {
    dataset: string;
    filters?: string;
  }): Promise<Schemas["BreakdownResponse"]> => {
    const s = new URLSearchParams({ dataset: q.dataset });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["BreakdownResponse"]>(vpath("/selection/breakdown"), s);
  },
};
