import type { components } from "./generated";

export type Schemas = components["schemas"];

// MeasurementCol is the closed set of `col` query-param values accepted by the
// binding/perturbation correlation + scatter endpoints. `log10pval` (added for
// BIND-1/PERT-1) resolves to the dataset's most-direct -log10(p) source and
// drives the scatter's server-side -log10(p) transform. Kept in one place so
// the routes, sidebars, scatter rows, and api callers share one source of
// truth. Matches openapi.yaml `enum: [effect, pvalue, log10pval]`.
export type MeasurementCol = "effect" | "pvalue" | "log10pval";

// CorrMethod is the closed set of `method` query-param values.
export type CorrMethod = "pearson" | "spearman";

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

// apiErrorMessage extracts a human-readable string from a thrown value for
// display in the UI. The backend's 4xx validation errors carry an intentional
// message in `{"error": "<msg>"}` (see backend writeJSONError) — surface THAT
// rather than the generic "HTTP 400" that ApiError.message defaults to, so the
// user sees e.g. "too many comparisons: … select fewer datasets" instead of a
// bare status code. Falls back to the status line when no message body exists,
// and degrades gracefully for non-ApiError throwables.
export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.body && typeof err.body === "object" && "error" in err.body) {
      const msg = (err.body as { error?: unknown }).error;
      if (typeof msg === "string" && msg.length > 0) return msg;
    }
    return err.message; // "HTTP <status>"
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

async function get<T>(
  path: string,
  search?: URLSearchParams,
  signal?: AbortSignal,
): Promise<T> {
  const url = path + (search && [...search].length ? `?${search.toString()}` : "");
  // Forward React Query's per-query AbortSignal so a superseded request (the
  // query key changed) or an unmounted observer (navigated away) actually
  // closes the HTTP connection. The server then cancels the in-flight DuckDB
  // query (returning 499) and frees the pool connection — without this, slow
  // queries like /comparison/topn pile up on the 2-conn pool and starve every
  // other request (e.g. the Select page freezes during rapid dataset edits).
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: signal ?? null,
  });
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
  datasets: (signal?: AbortSignal): Promise<Schemas["DatasetsResponse"]> =>
    get<Schemas["DatasetsResponse"]>(vpath("/datasets"), undefined, signal),
  regulators: (
    q: { search?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<Schemas["RegulatorsResponse"]> => {
    const s = new URLSearchParams();
    if (q.search) s.set("search", q.search);
    if (q.limit) s.set("limit", String(q.limit));
    return get<Schemas["RegulatorsResponse"]>(vpath("/regulators"), s, signal);
  },
  resolve: (
    q: {
      common?: string;
      intersect?: string;
      regulators?: string[];
      // SD-1: active dataset filters (FiltersByDB-shape JSON) so the common
      // set is computed filter-aware, matching the matrix cell. regulator_locus_tag
      // is stripped server-side.
      filters?: string;
    },
    signal?: AbortSignal,
  ): Promise<Schemas["ResolveResponse"]> => {
    const s = new URLSearchParams();
    if (q.common) s.set("common", q.common);
    if (q.intersect) s.set("intersect", q.intersect);
    if (q.regulators && q.regulators.length) s.set("regulators", q.regulators.join(","));
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["ResolveResponse"]>(vpath("/regulators/resolve"), s, signal);
  },
  binding: (
    q: {
      regulator: string;
      datasets: string[];
      filters?: string;
    },
    signal?: AbortSignal,
  ): Promise<Schemas["BindingResponse"]> => {
    const s = new URLSearchParams({ regulator: q.regulator, datasets: q.datasets.join(",") });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["BindingResponse"]>(vpath("/binding"), s, signal);
  },
  perturbation: (
    q: {
      regulator: string;
      datasets: string[];
      filters?: string;
    },
    signal?: AbortSignal,
  ): Promise<Schemas["PerturbationResponse"]> => {
    const s = new URLSearchParams({ regulator: q.regulator, datasets: q.datasets.join(",") });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["PerturbationResponse"]>(vpath("/perturbation"), s, signal);
  },
  topn: (
    q: {
      binding: string[];
      perturbation: string[];
      top_n?: number;
      effect?: number;
      pvalue?: number;
      filters?: string;
    },
    signal?: AbortSignal,
  ): Promise<Schemas["TopNResponse"]> => {
    const s = new URLSearchParams({
      binding: q.binding.join(","),
      perturbation: q.perturbation.join(","),
    });
    if (q.top_n) s.set("top_n", String(q.top_n));
    if (q.effect !== undefined) s.set("effect", String(q.effect));
    if (q.pvalue !== undefined) s.set("pvalue", String(q.pvalue));
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["TopNResponse"]>(vpath("/comparison/topn"), s, signal);
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
  bindingCorr: (
    q: {
      datasets: string[];
      method: CorrMethod;
      col: MeasurementCol;
      filters?: string;
    },
    signal?: AbortSignal,
  ): Promise<Schemas["CorrResponse"]> => {
    const s = new URLSearchParams({
      datasets: q.datasets.join(","),
      method: q.method,
      col: q.col,
    });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["CorrResponse"]>(vpath("/binding/corr"), s, signal);
  },
  bindingScatter: (
    q: {
      regulator: string;
      pair: [string, string];
      method: CorrMethod;
      col: MeasurementCol;
      filters?: string;
    },
    signal?: AbortSignal,
  ): Promise<Schemas["ScatterResponse"]> => {
    const s = new URLSearchParams({
      regulator: q.regulator,
      pair: q.pair.join(","),
      method: q.method,
      col: q.col,
    });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["ScatterResponse"]>(vpath("/binding/scatter"), s, signal);
  },
  perturbationCorrelations: (
    q: {
      datasets: string[];
      method: CorrMethod;
      col: MeasurementCol;
      filters?: string;
    },
    signal?: AbortSignal,
  ): Promise<Schemas["CorrResponse"]> => {
    const s = new URLSearchParams({
      datasets: q.datasets.join(","),
      method: q.method,
      col: q.col,
    });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["CorrResponse"]>(vpath("/perturbation/correlations"), s, signal);
  },
  perturbationScatter: (
    q: {
      regulator: string;
      pair: [string, string];
      method: CorrMethod;
      col: MeasurementCol;
      filters?: string;
    },
    signal?: AbortSignal,
  ): Promise<Schemas["ScatterResponse"]> => {
    const s = new URLSearchParams({
      regulator: q.regulator,
      pair: q.pair.join(","),
      method: q.method,
      col: q.col,
    });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["ScatterResponse"]>(vpath("/perturbation/scatter"), s, signal);
  },

  // ----- Select Datasets endpoints (Phase A5) -----------------------------
  // Backend handlers: /api/v/{v}/datasets/{db}/{fields,regulators} and
  // /api/v/{v}/selection/{matrix,breakdown}. Consumed by the Phase-B Select
  // Datasets rebuild (Task B4); not wired into any UI yet.
  datasetFields: (
    q: { db: string },
    signal?: AbortSignal,
  ): Promise<Schemas["DatasetFieldsResponse"]> =>
    get<Schemas["DatasetFieldsResponse"]>(
      vpath(`/datasets/${encodeURIComponent(q.db)}/fields`),
      undefined,
      signal,
    ),
  datasetRegulators: (
    q: { db: string },
    signal?: AbortSignal,
  ): Promise<Schemas["DatasetRegulatorsResponse"]> =>
    get<Schemas["DatasetRegulatorsResponse"]>(
      vpath(`/datasets/${encodeURIComponent(q.db)}/regulators`),
      undefined,
      signal,
    ),
  // Per-dataset sample_id → condition-label map used by the binding /
  // perturbation correlation overlay hovertext. See
  // docs/parity/binding.md rows 21, 42.
  sampleConditions: (
    q: { db: string },
    signal?: AbortSignal,
  ): Promise<Schemas["SampleConditionsResponse"]> =>
    get<Schemas["SampleConditionsResponse"]>(
      vpath(`/datasets/${encodeURIComponent(q.db)}/sample-conditions`),
      undefined,
      signal,
    ),
  selectionMatrix: (
    q: {
      datasets: string[];
      filters?: string;
    },
    signal?: AbortSignal,
  ): Promise<Schemas["MatrixResponse"]> => {
    const s = new URLSearchParams({ datasets: q.datasets.join(",") });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["MatrixResponse"]>(vpath("/selection/matrix"), s, signal);
  },
  selectionBreakdown: (
    q: {
      dataset: string;
      filters?: string;
    },
    signal?: AbortSignal,
  ): Promise<Schemas["BreakdownResponse"]> => {
    const s = new URLSearchParams({ dataset: q.dataset });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["BreakdownResponse"]>(vpath("/selection/breakdown"), s, signal);
  },

  // ----- Export endpoint (Phase C6) ---------------------------------------
  // Returns the URL string only — we deliberately do NOT fetch here. The
  // browser handles the binary stream via top-level navigation
  // (`window.location.href = url`) so the download UX is "click → File
  // Save dialog" and the response never has to land in JS memory. See
  // docs/parity/select_datasets.md rows 35, 36.
  exportUrl: (q: { datasets: string[]; filters?: string }): string => {
    const s = new URLSearchParams({ datasets: q.datasets.join(",") });
    if (q.filters) s.set("filters", q.filters);
    return vpath("/export") + (s.toString() ? `?${s.toString()}` : "");
  },
};
