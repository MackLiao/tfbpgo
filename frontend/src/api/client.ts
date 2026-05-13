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
  dto: (): Promise<Schemas["DTOResponse"]> => get<Schemas["DTOResponse"]>(vpath("/comparison/dto")),
};
