// AUTO-GENERATED — do not edit. Run `pnpm types:gen`.
export interface paths {
    "/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Liveness probe
         * @description Always returns 200 if the process is running.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Process is alive. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HealthzResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/readyz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Readiness probe
         * @description Returns 200 when the DuckDB pool is open, the artifact_manifest canary
         *     query succeeds, and the cache is initialized. Returns 503 with a
         *     `reason` field otherwise.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Service is ready to accept traffic. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ReadyzResponse"];
                    };
                };
                /** @description Service is not ready. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ReadyzResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/version": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Running artifact version metadata
         * @description Returns the currently-loaded artifact's version, schema version, build
         *     timestamp, and DuckDB version. The `artifactVersion` value is the
         *     `{v}` path segment all `/api/v/{v}/*` endpoints expect.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Version metadata for the loaded artifact. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["VersionInfo"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/datasets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List available datasets and their fields */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description All datasets registered in the artifact's dataset_manifest. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DatasetsResponse"];
                    };
                };
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/datasets/{db}/fields": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Per-field metadata for one dataset's filter modal
         * @description Returns one entry per `field_manifest` row for the dataset, joined
         *     with runtime DuckDB type introspection (`information_schema.columns`),
         *     the `filter_level_cache` snapshot, and — for numeric fields — a
         *     computed `MIN/MAX` aggregate. The `kind` field is the categorical/
         *     numeric/bool bucket the filter modal renders; `FIELD_TYPE_OVERRIDES`
         *     (currently only `hackett.time`) wins over the raw DB type.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                    /** @description Dataset db_name. Must be in `dataset_manifest`. */
                    db: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Field metadata for the dataset. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DatasetFieldsResponse"];
                    };
                };
                400: components["responses"]["BadRequest"];
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/datasets/{db}/regulators": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Distinct regulators (locus tag + symbol) for one dataset
         * @description Powers the filter modal's per-dataset Regulator selectize. Returns
         *     every distinct `(regulator_locus_tag, regulator_symbol)` pair in
         *     `{db}_meta` ordered by locus_tag, plus a server-built `display`
         *     string (`"SYMBOL (LOCUS_TAG)"` when symbol differs from the locus
         *     tag, else just the locus tag). Mirrors Shiny's
         *     `regulator_display_labels_query` in
         *     `reference/tfbpshiny/modules/select_datasets/queries.py:188-205`.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                    db: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Distinct regulators present in the dataset. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DatasetRegulatorsResponse"];
                    };
                };
                400: components["responses"]["BadRequest"];
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/datasets/{db}/sample-conditions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Per-sample condition-label map for one dataset
         * @description Returns the `{sample_id: condition_label}` map used by the
         *     binding/perturbation correlation overlay hover tooltips. Mirrors
         *     Shiny's `fetch_sample_condition_map`
         *     (`reference/tfbpshiny/utils/sample_conditions.py:55-94`). Source
         *     columns come from `dataset_manifest.condition_cols` (CSV;
         *     schema_version=4). The label is the per-row join of non-empty
         *     trimmed values with `" / "`. Samples whose composed label is
         *     empty are omitted. When `condition_cols` is empty, returns an
         *     empty `labels` object and `conditionCols: []`.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                    db: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Sample-condition label map. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SampleConditionsResponse"];
                    };
                };
                400: components["responses"]["BadRequest"];
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/selection/matrix": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Diagonal regulator/sample counts + pairwise common regulator counts
         * @description Returns the data behind the Select Datasets intersection-matrix
         *     workspace. Mirrors Shiny's `_matrix_data()` shape: one
         *     `MatrixDiagonalCell` per active dataset (distinct regulator +
         *     distinct sample counts, post-filter) plus one `MatrixCrossCell` for
         *     every `sorted(datasets) choose 2` pair (common regulators via SQL
         *     INTERSECT, restricted distinct sample counts per side).
         */
        get: {
            parameters: {
                query: {
                    /**
                     * @description Comma-separated active dataset db_names. At least one entry; all
                     *     must be present in `dataset_manifest`. Order is normalized to
                     *     `sorted()` before pairs are computed so cache values are stable
                     *     across param-order permutations.
                     */
                    datasets: string;
                    /**
                     * @description URL-encoded JSON object of shape `FiltersByDB` (see schema). The raw
                     *     string is capped at 16 KiB before unmarshal to prevent DoS.
                     */
                    filters?: components["parameters"]["Filters"];
                };
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Diagonal + pairwise cross-dataset cells. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["MatrixResponse"];
                    };
                };
                400: components["responses"]["BadRequest"];
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/selection/breakdown": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Multi-sample regulator breakdown for one dataset's diagonal modal
         * @description Powers the diagonal-cell modal of the Select Datasets workspace.
         *     Returns `n_multi` (number of regulators with > 1 sample) plus one
         *     entry per candidate column with the count of regulators whose
         *     per-row distinct value for that column is > 1 (i.e. the columns
         *     that actually differentiate samples within a multi-sample
         *     regulator). Mirrors Shiny's `regulator_breakdown_query`
         *     (`reference/tfbpshiny/modules/select_datasets/queries.py:133-185`).
         */
        get: {
            parameters: {
                query: {
                    /** @description Dataset db_name. Must be in `dataset_manifest`. */
                    dataset: string;
                    /**
                     * @description URL-encoded JSON object of shape `FiltersByDB` (see schema). The raw
                     *     string is capped at 16 KiB before unmarshal to prevent DoS.
                     */
                    filters?: components["parameters"]["Filters"];
                };
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Multi-sample regulator breakdown. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BreakdownResponse"];
                    };
                };
                400: components["responses"]["BadRequest"];
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/regulators": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search regulators by locus tag or symbol */
        get: {
            parameters: {
                query?: {
                    /** @description Case-insensitive prefix match against locus_tag and symbol. Capped at 64 chars. */
                    search?: string;
                    /** @description Maximum rows returned. Clamped to [1, 100]; defaults to 25. */
                    limit?: number;
                };
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Matching regulators. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RegulatorsResponse"];
                    };
                };
                400: components["responses"]["BadRequest"];
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/regulators/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Resolve a user-supplied regulator list to canonical locus tags
         * @description Added in Phase 2 Task 2. Accepts a list of free-form regulator tokens
         *     (locus tags, symbols, or display names) and returns the canonical
         *     locus_tag list. Supports a `common` mode that intersects against the
         *     set of regulators present across requested datasets.
         */
        get: {
            parameters: {
                query?: {
                    /**
                     * @description Comma-separated list of regulator locus tags to resolve. Capped at
                     *     30 raw entries (request rejected if exceeded); the server deduplicates
                     *     and uppercases entries before processing.
                     */
                    regulators?: string;
                    /**
                     * @description Sugar for `intersect`: a colon-separated pair `A:B` of dataset
                     *     db_names (e.g. `callingcards:hackett`). Equivalent to
                     *     `intersect=A,B`. Optional `binding.` / `perturbation.` prefixes are
                     *     accepted on each side. If both `common` and `intersect` are set,
                     *     `common` wins.
                     */
                    common?: string;
                    /**
                     * @description Comma-separated dataset db_names to intersect. Each name must be in
                     *     `dataset_manifest`. Optional `binding.` / `perturbation.` prefixes
                     *     are accepted; the prefix (if present) must match the dataset's
                     *     actual `data_type`. The list is capped at the dataset manifest size.
                     */
                    intersect?: string;
                };
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Canonical locus_tag list (deduplicated, order preserved). */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ResolveResponse"];
                    };
                };
                400: components["responses"]["BadRequest"];
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/binding": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Binding rows for one regulator across one or more binding datasets */
        get: {
            parameters: {
                query: {
                    /** @description Regulator locus_tag (required). */
                    regulator: string;
                    /**
                     * @description Comma-separated binding dataset db_names. Each must be present in
                     *     `dataset_manifest` AND have `data_type=binding`. Limited to the
                     *     count of datasets in the manifest.
                     */
                    datasets?: string;
                    /**
                     * @description URL-encoded JSON object of shape `FiltersByDB` (see schema). The raw
                     *     string is capped at 16 KiB before unmarshal to prevent DoS.
                     */
                    filters?: components["parameters"]["Filters"];
                };
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Per-dataset binding rows for the regulator. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BindingResponse"];
                    };
                };
                400: components["responses"]["BadRequest"];
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/perturbation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Perturbation rows for one regulator across one or more perturbation datasets */
        get: {
            parameters: {
                query: {
                    /** @description Regulator locus_tag (required). */
                    regulator: string;
                    /**
                     * @description Comma-separated perturbation dataset db_names. Each must be present
                     *     in `dataset_manifest` AND have `data_type=perturbation`. Limited to
                     *     the count of datasets in the manifest.
                     */
                    datasets?: string;
                    /**
                     * @description URL-encoded JSON object of shape `FiltersByDB` (see schema). The raw
                     *     string is capped at 16 KiB before unmarshal to prevent DoS.
                     */
                    filters?: components["parameters"]["Filters"];
                };
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Per-dataset perturbation rows for the regulator. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PerturbationResponse"];
                    };
                };
                400: components["responses"]["BadRequest"];
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/binding/corr": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Per-regulator correlation between two or more binding datasets
         * @description Returns Pearson- or Spearman-correlated (regulator, sample_a, sample_b)
         *     groups for every pair drawn from `sorted(datasets) choose 2`. The
         *     underlying SQL templates (`backend/internal/queries/binding/corr_pair_*.sql`)
         *     mirror Shiny's `_corr_pair_sql_impl` exactly: INNER JOIN on (regulator,
         *     target), NULL/Inf/NaN exclusion, and a `HAVING COUNT(*) >= 3` floor.
         */
        get: {
            parameters: {
                query: {
                    /**
                     * @description Comma-separated binding dataset db_names. At least 2 entries; all
                     *     must be present in `dataset_manifest` AND have `data_type=binding`.
                     */
                    datasets: string;
                    /** @description Correlation method (`pearson` for raw values, `spearman` for ranks). */
                    method: "pearson" | "spearman";
                    /**
                     * @description Measurement column kind. `effect` selects `dataset_manifest.effect_col`;
                     *     `pvalue` selects `dataset_manifest.pvalue_col` (falling back to
                     *     `effect_col` when the dataset has no p-value column, matching Shiny's
                     *     `get_measurement_column`).
                     */
                    col: "effect" | "pvalue";
                    /**
                     * @description URL-encoded JSON object of shape `FiltersByDB` (see schema). The raw
                     *     string is capped at 16 KiB before unmarshal to prevent DoS.
                     */
                    filters?: components["parameters"]["Filters"];
                };
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Correlation envelope; one CorrPair per `(dbA, dbB)` combination. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CorrResponse"];
                    };
                };
                400: components["responses"]["BadRequest"];
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/binding/scatter": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Per-target value pairs for one regulator across two binding datasets
         * @description Returns (target, val_a, val_b) tuples for a single regulator across one
         *     pair of binding datasets. For `method=spearman`, val_* are rank values
         *     produced by `RANK() OVER`. The server computes `r` (Pearson correlation
         *     over the returned points) using the same algorithm class as DuckDB's
         *     `corr()`; the value is clamped to [-1, 1] and coerced to 0 when fewer
         *     than 2 points are returned or the variance is zero (mirrors Shiny's
         *     NaN-coercion behavior).
         */
        get: {
            parameters: {
                query: {
                    /** @description Regulator locus_tag (required); bound as a positional `?` in the SQL. */
                    regulator: string;
                    /**
                     * @description Comma-separated pair of binding dataset db_names (exactly 2 entries).
                     *     Both must have `data_type=binding`. **Order is significant**: the
                     *     first entry becomes `dbA` (rendered as the scatter plot's x-axis,
                     *     `val_a` in each point), and the second becomes `dbB` (y-axis,
                     *     `val_b`). `pair=A,B` and `pair=B,A` produce transposed responses
                     *     and therefore distinct cache entries.
                     */
                    pair: string;
                    method: "pearson" | "spearman";
                    col: "effect" | "pvalue";
                    /**
                     * @description URL-encoded JSON object of shape `FiltersByDB` (see schema). The raw
                     *     string is capped at 16 KiB before unmarshal to prevent DoS.
                     */
                    filters?: components["parameters"]["Filters"];
                };
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Per-target value pairs for the regulator. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ScatterResponse"];
                    };
                };
                400: components["responses"]["BadRequest"];
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/perturbation/correlations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Per-regulator correlation between two or more perturbation datasets
         * @description Perturbation analogue of `/binding/corr`. The path uses the plural
         *     `correlations` (vs `corr` on the binding side) to match the original
         *     Shiny module's naming and the parity audit in
         *     `docs/parity/perturbation.md`. Same response shape as `/binding/corr`.
         */
        get: {
            parameters: {
                query: {
                    /**
                     * @description Comma-separated perturbation dataset db_names. At least 2 entries;
                     *     all must have `data_type=perturbation`.
                     */
                    datasets: string;
                    method: "pearson" | "spearman";
                    col: "effect" | "pvalue";
                    /**
                     * @description URL-encoded JSON object of shape `FiltersByDB` (see schema). The raw
                     *     string is capped at 16 KiB before unmarshal to prevent DoS.
                     */
                    filters?: components["parameters"]["Filters"];
                };
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Correlation envelope; one CorrPair per `(dbA, dbB)` combination. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CorrResponse"];
                    };
                };
                400: components["responses"]["BadRequest"];
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/perturbation/scatter": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Per-target value pairs for one regulator across two perturbation datasets
         * @description Perturbation analogue of `/binding/scatter`. See that endpoint's
         *     description for the per-target row shape and server-side Pearson r
         *     computation.
         */
        get: {
            parameters: {
                query: {
                    regulator: string;
                    /**
                     * @description Comma-separated pair of perturbation dataset db_names (exactly 2
                     *     entries). **Order is significant**: the first entry becomes `dbA`
                     *     (x-axis, `val_a` in each point), and the second becomes `dbB`
                     *     (y-axis, `val_b`). `pair=A,B` and `pair=B,A` produce transposed
                     *     responses and distinct cache entries.
                     */
                    pair: string;
                    method: "pearson" | "spearman";
                    col: "effect" | "pvalue";
                    /**
                     * @description URL-encoded JSON object of shape `FiltersByDB` (see schema). The raw
                     *     string is capped at 16 KiB before unmarshal to prevent DoS.
                     */
                    filters?: components["parameters"]["Filters"];
                };
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Per-target value pairs for the regulator. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ScatterResponse"];
                    };
                };
                400: components["responses"]["BadRequest"];
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/comparison/topn": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Top-N responsive-ratio rows for binding x perturbation pairs */
        get: {
            parameters: {
                query?: {
                    /** @description Comma-separated binding dataset db_names. */
                    binding?: string;
                    /** @description Comma-separated perturbation dataset db_names. */
                    perturbation?: string;
                    /** @description Top N rows per (binding, perturbation) pair. Clamped to [1, 10000]; defaults to 25. */
                    top_n?: number;
                    /** @description Effect-size threshold for the responsive predicate. Default `0.0`. */
                    effect?: number;
                    /** @description P-value threshold for the responsive predicate. Default `0.05`. */
                    pvalue?: number;
                    /**
                     * @description URL-encoded JSON object of shape `FiltersByDB` (see schema). The raw
                     *     string is capped at 16 KiB before unmarshal to prevent DoS.
                     */
                    filters?: components["parameters"]["Filters"];
                };
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description TopN rows across the requested binding/perturbation pairs. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TopNResponse"];
                    };
                };
                400: components["responses"]["BadRequest"];
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/comparison/dto": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Precomputed DTO (downstream/target-overlap) comparison rows */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description All rows from the DTO precomputed comparison table. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DTOResponse"];
                    };
                };
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v/{v}/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Stream a per-dataset .tar.gz with metadata + features + README
         * @description STREAMS a multi-dataset `.tar.gz` archive. One subdirectory per
         *     requested dataset (named by `db_name`); each contains:
         *
         *     - **metadata.csv** — `SELECT * FROM {db}_meta {filters}`
         *     - **annotated_features.csv** — `SELECT * FROM {db} {filters}`
         *     - **README.md** — dataset name, display name, applied filters
         *
         *     Mirrors `reference/tfbpshiny/modules/select_datasets/export.py`
         *     (lines 39–213). Gzip `compresslevel=1` matches the Shiny export.
         *
         *     Rows are streamed from the DuckDB cursor into the CSV writer one
         *     row at a time (no full result-set materialisation). Each CSV
         *     is buffered once-per-dataset because the tar stdlib API needs
         *     the entry `Size` up front; peak memory is one dataset's CSV at
         *     a time.
         *
         *     The handler detaches from the global 30-second router timeout
         *     (via `context.WithoutCancel`) and applies its own **5-minute
         *     timeout**, so a large export does not get cut off mid-stream.
         *     It holds one of the two DB pool connections for the entire
         *     export duration; the other connection remains available so the
         *     rest of the API stays responsive.
         *
         *     Response is **never cached** (`Cache-Control: no-store`).
         */
        get: {
            parameters: {
                query: {
                    /**
                     * @description Comma-separated dataset `db_name`s. Each must appear in
                     *     `dataset_manifest`; unknown names → 400. Capped at the
                     *     total number of datasets in the manifest.
                     */
                    datasets: string;
                    /**
                     * @description URL-encoded JSON object of shape `FiltersByDB` (see schema). The raw
                     *     string is capped at 16 KiB before unmarshal to prevent DoS.
                     */
                    filters?: components["parameters"]["Filters"];
                };
                header?: never;
                path: {
                    /**
                     * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
                     *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
                     */
                    v: components["parameters"]["ArtifactVersion"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /**
                 * @description Streamed gzip-compressed tar archive. `Content-Disposition`
                 *     is `attachment; filename="tfbp-export-<UTC-timestamp>.tar.gz"`.
                 *     No `Content-Length` is set (length unknown until the stream
                 *     completes).
                 */
                200: {
                    headers: {
                        /** @description Forces the browser to treat the response as a download. */
                        "Content-Disposition"?: string;
                        /** @description Always `no-store`. Per-request uniques and large bodies make caching counter-productive. */
                        "Cache-Control"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/gzip": string;
                    };
                };
                400: components["responses"]["BadRequest"];
                410: components["responses"]["StaleArtifactVersion"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        HealthzResponse: {
            /** @example true */
            alive: boolean;
        };
        ReadyzResponse: {
            ready: boolean;
            /** @description Present only when `ready` is false. */
            reason?: string;
        };
        ErrorResponse: {
            /** @description Human-readable error message. */
            error: string;
        };
        VersionInfo: {
            /** @description Artifact version baked into every cache key. */
            artifactVersion: string;
            /** @description Schema version compatible with this server build. */
            schemaVersion: number;
            /**
             * Format: date-time
             * @description RFC3339 timestamp of when the artifact was built.
             */
            builtAt: string;
            /** @description DuckDB storage version (informational only; not a startup gate). */
            duckdbVersion: string;
        };
        DatasetEntry: {
            dbName: string;
            /** @description Either `binding` or `perturbation`. */
            dataType: string;
            assay: string;
            displayName: string;
            sourceRepo: string;
            sampleIdField: string;
            fields: string[];
            /**
             * @description v4: whether the dataset should be pre-selected on first visit.
             *     Mirrors Shiny's `DEFAULT_ACTIVE_DATASETS`
             *     (`reference/tfbpshiny/utils/vdb_init.py:40-50`).
             */
            defaultActive: boolean;
            /**
             * @description v4: opaque JSON `{field: FilterSpec}` object to apply as the
             *     initial filter state on first visit, or `null` when the
             *     artifact has no preset. Forwarded verbatim from
             *     `dataset_manifest` (as a JSON object on the wire, NOT a
             *     JSON-encoded string); clients consume directly. Mirrors
             *     `DEFAULT_DATASET_FILTERS` (`vdb_init.py:55-68`).
             */
            defaultFilters: {
                [key: string]: unknown;
            } | null;
            /**
             * @description v4: ordered list of field names whose values together form the
             *     sample-condition label shown in binding/perturbation hover
             *     tooltips. Server-parsed from the comma-separated form in
             *     `dataset_manifest.condition_cols`.
             */
            conditionCols: string[];
        };
        DatasetsResponse: {
            datasets: components["schemas"]["DatasetEntry"][];
        };
        Regulator: {
            locusTag: string;
            symbol: string;
            displayName: string;
        };
        RegulatorsResponse: {
            regulators: components["schemas"]["Regulator"][];
        };
        ResolveResponse: {
            /**
             * @description Canonical, sorted, deduplicated locus_tag list. Capped at 1000
             *     entries server-side; `truncated:true` indicates the cap was hit.
             */
            regulators: string[];
            /**
             * @description True when the resolved list exceeded the 1000-tag cap and was
             *     trimmed. Clients should consider narrowing the dataset intersection
             *     or providing an explicit `regulators` list.
             */
            truncated?: boolean;
        };
        BindingRow: {
            regulatorLocusTag: string;
            targetLocusTag: string;
            sampleId: string;
            /** Format: double */
            value: number;
        };
        BindingDatasetResult: {
            dbName: string;
            /** @description Measurement column projected as `value` for this dataset. */
            column: string;
            rows: components["schemas"]["BindingRow"][];
        };
        BindingResponse: {
            regulator: string;
            datasets: components["schemas"]["BindingDatasetResult"][];
        };
        PerturbationRow: {
            regulatorLocusTag: string;
            targetLocusTag: string;
            sampleId: string;
            /** Format: double */
            value: number;
        };
        PerturbationDatasetResult: {
            dbName: string;
            /** @description Measurement column projected as `value` for this dataset. */
            column: string;
            rows: components["schemas"]["PerturbationRow"][];
        };
        PerturbationResponse: {
            regulator: string;
            datasets: components["schemas"]["PerturbationDatasetResult"][];
        };
        TopNRow: {
            /** @description Composite key of the form `{bindingDB}__{perturbationDB}`. */
            pairKey: string;
            bindingSampleId: string;
            regulatorLocusTag: string;
            /**
             * @description Display name from `regulator_display_names` (LEFT JOIN on
             *     `regulator_locus_tag`). Null when the locus tag has no entry in
             *     that table. Used by the Comparison module for the per-point
             *     hover tooltip (parity with Shiny `get_regulator_display_name`).
             */
            regulatorDisplayName: string | null;
            perturbationSampleId: string;
            /**
             * Format: int64
             * @description Number of binding-ranked targets considered.
             */
            n: number;
            /**
             * Format: int64
             * @description How many of those targets cleared the responsive predicate.
             */
            nResponsive: number;
            /** Format: double */
            responsiveRatio: number;
        };
        TopNResponse: {
            topN: number;
            /** Format: double */
            effectThreshold: number;
            /** Format: double */
            pvalueThreshold: number;
            rows: components["schemas"]["TopNRow"][];
        };
        DTORow: {
            bindingIdSource: string;
            perturbationIdSource: string;
            /** Format: double */
            dtoEmpiricalPvalue: number;
            /** Format: double */
            dtoFdr: number;
            /** Format: int64 */
            bindingSetSize: number;
            /** Format: int64 */
            perturbationSetSize: number;
            bindingSampleId: string;
            pertSampleId: string;
            time: string;
        };
        DTOResponse: {
            rows: components["schemas"]["DTORow"][];
        };
        CorrPairPoint: {
            /** @description Dataset db_name on the A side. */
            dbA: string;
            /** @description sample_id from dataset A. */
            dbAId: string;
            dbB: string;
            dbBId: string;
            regulatorLocusTag: string;
            /**
             * Format: double
             * @description corr() value for this (regulator, dbAId, dbBId) group. For Pearson,
             *     computed over raw measurement values; for Spearman, computed over
             *     RANK() outputs. Clamped to [-1, 1] in practice.
             */
            correlation: number;
        };
        CorrPair: {
            /** @description Dataset db_name on the A side of this pair. */
            dbA: string;
            /** @description Dataset db_name on the B side of this pair. */
            dbB: string;
            /** @description Measurement column actually used on the A side. */
            colA: string;
            /** @description Measurement column actually used on the B side. */
            colB: string;
            /** @description Per-regulator correlation values for this pair. */
            points: components["schemas"]["CorrPairPoint"][];
        };
        CorrResponse: {
            /** @enum {string} */
            method: "pearson" | "spearman";
            /** @enum {string} */
            col: "effect" | "pvalue";
            /**
             * @description One entry per `(dbA, dbB)` combination drawn from
             *     `sorted(datasets) choose 2`. Ordering is stable across param-order
             *     permutations so cache values are deterministic.
             */
            pairs: components["schemas"]["CorrPair"][];
            /**
             * @description Maps each regulator_locus_tag appearing in `pairs` to its
             *     "SYMBOL (LOCUS_TAG)" display name (from regulator_display_names),
             *     mirroring Shiny's sym_map. The frontend uses it to label + sort the
             *     regulator picker and boxplot hovers by gene symbol (B-2/P-4).
             *     Regulators absent from regulator_display_names are omitted.
             */
            regulatorDisplay: {
                [key: string]: string;
            };
        };
        ScatterPoint: {
            /** @description Target gene locus tag (one row per target shared between A and B). */
            targetLocusTag: string;
            /**
             * Format: double
             * @description Measurement value on the A side. Raw value for Pearson; RANK()
             *     output for Spearman. Null when the underlying measurement is
             *     NULL/NaN/Inf (B-1: the scatter path is intentionally unfiltered, so
             *     non-finite values render as plot gaps rather than being dropped).
             */
            valA: number | null;
            /**
             * Format: double
             * @description Measurement value on the B side. Raw value for Pearson; RANK()
             *     output for Spearman. Null when the underlying measurement is
             *     NULL/NaN/Inf (see valA).
             */
            valB: number | null;
        };
        ScatterResponse: {
            /** @description Regulator locus_tag the scatter was computed for. */
            regulator: string;
            /** @description Dataset db_name on the A side of the scatter pair. */
            dbA: string;
            /** @description Dataset db_name on the B side of the scatter pair. */
            dbB: string;
            /** @description Measurement column actually used on the A side. */
            colA: string;
            /** @description Measurement column actually used on the B side. */
            colB: string;
            /** @enum {string} */
            method: "pearson" | "spearman";
            /**
             * Format: double
             * @description Pearson correlation computed server-side over the returned points,
             *     mirroring pandas Series.corr (B-1): NaN/NULL pairs are dropped
             *     pairwise, and a ±Inf value propagates to null. Null when an Inf
             *     value is present. 0 when fewer than 2 finite pairs remain or the
             *     series has zero variance. Clamped to [-1, 1].
             */
            r: number | null;
            points: components["schemas"]["ScatterPoint"][];
        };
        /**
         * @description One field's combined manifest + introspection metadata. `dbType` is
         *     the raw DuckDB column type ("VARCHAR", "DOUBLE", "INTEGER", ...) at
         *     first request time; `kind` is the categorical/numeric/bool bucket
         *     the filter modal should render, after `uiKindOverride` is applied.
         *     In v4 the override is sourced from `field_manifest.ui_kind_override`
         *     (was a Go-side constant in v3).
         */
        FieldMeta: {
            field: string;
            /** @description Raw DuckDB type ("VARCHAR", "DOUBLE", ...). Empty when the column is absent from both `{db}` and `{db}_meta`. */
            dbType: string;
            /** @enum {string} */
            kind: "categorical" | "numeric" | "bool";
            /** @description Either `""` or `"experimental_condition"` (from `field_manifest.role`). */
            role: string;
            /**
             * @description v4: free-text tooltip copy from `field_manifest.description`.
             *     Capped server-side at 1 KB. Frontend MUST HTML-escape on
             *     render — this string may contain any UTF-8. Omitted when
             *     empty.
             */
            description?: string;
            /**
             * @description v4: opaque JSON `{level: label}` object from
             *     `field_manifest.level_definitions`. Emitted as a JSON
             *     object (NOT a JSON-encoded string) so clients consume
             *     directly. Capped at 16 KB server-side. Omitted when the
             *     manifest value is empty.
             */
            levelDefinitions?: {
                [key: string]: unknown;
            };
            /**
             * @description v4: raw `field_manifest.ui_kind_override` value. When non-empty
             *     it overrides DuckDB-type-driven `kind` inference. Empty
             *     string means "no override; use DuckDB type". Omitted when
             *     empty.
             * @enum {string}
             */
            uiKindOverride?: "" | "categorical" | "numeric" | "bool";
            /**
             * @description v4: for categorical fields whose level labels look numeric
             *     ("45", "90"), whether to sort numerically (`"numeric"`) or
             *     lexicographically (`"string"`). Empty string means default
             *     sort. Omitted when empty.
             * @enum {string}
             */
            numericLevelSort?: "" | "numeric" | "string";
            /** @description filter_level_cache values for the field, sorted by the build pipeline. Omitted when the field has no cached levels. */
            levels?: string[];
            /**
             * Format: double
             * @description Aggregate `MIN(field)` for numeric-kind fields. Null when the column is all-null/empty.
             */
            numericMin?: number | null;
            /**
             * Format: double
             * @description Aggregate `MAX(field)` for numeric-kind fields.
             */
            numericMax?: number | null;
        };
        DatasetFieldsResponse: {
            dbName: string;
            fields: components["schemas"]["FieldMeta"][];
        };
        DatasetRegulator: {
            locusTag: string;
            symbol: string;
            /** @description Server-rendered `"SYMBOL (LOCUS_TAG)"` (or just LOCUS_TAG when symbol is missing/equal). */
            display: string;
        };
        DatasetRegulatorsResponse: {
            dbName: string;
            regulators: components["schemas"]["DatasetRegulator"][];
        };
        SampleConditionsResponse: {
            dbName: string;
            /**
             * @description Per-dataset condition columns from
             *     `dataset_manifest.condition_cols`. Empty array when the
             *     dataset has no condition columns configured.
             */
            conditionCols: string[];
            /**
             * @description Map from `sample_id` to the joined condition label
             *     (`" / "`-separated). Samples whose composed label is empty
             *     are omitted.
             */
            labels: {
                [key: string]: string;
            };
        };
        MatrixDiagonalCell: {
            dbName: string;
            /** Format: int64 */
            nRegulators: number;
            /** Format: int64 */
            nSamples: number;
        };
        MatrixCrossCell: {
            /** @description Composite `"{dbA}__{dbB}"` key. */
            pairId: string;
            dbA: string;
            dbB: string;
            /**
             * Format: int64
             * @description Distinct regulators present in both datasets (post-filter).
             */
            nCommon: number;
            /**
             * Format: int64
             * @description Distinct sample count on the A side restricted to the common-regulator set.
             */
            samplesA: number;
            /** Format: int64 */
            samplesB: number;
        };
        MatrixResponse: {
            diagonal: components["schemas"]["MatrixDiagonalCell"][];
            crossDataset: components["schemas"]["MatrixCrossCell"][];
        };
        BreakdownColumn: {
            field: string;
            /**
             * Format: int64
             * @description Count of multi-sample regulators whose per-regulator distinct
             *     value for this column is > 1. Equivalently: how many regulators
             *     this column actually differentiates within the multi-sample
             *     subset. 0 means the column is uniform across that subset.
             */
            distinctValues: number;
        };
        BreakdownResponse: {
            dbName: string;
            /**
             * Format: int64
             * @description Number of regulators with more than one sample (post-filter).
             */
            nMulti: number;
            columns: components["schemas"]["BreakdownColumn"][];
        };
        /**
         * @description One field-level filter clause. `value` is polymorphic and depends on
         *     `type`:
         *       - `categorical`: array of strings (IN-list).
         *       - `numeric`:     two-element [min, max] number tuple (inclusive).
         *       - `bool`:        plain boolean.
         *     The backend validates the shape per `type` at request time and rejects
         *     mismatches with 400.
         */
        FilterSpec: {
            /** @enum {string} */
            type: "categorical" | "numeric" | "bool";
            value: string[] | number[] | boolean;
        };
        /**
         * @description Filters keyed by dataset db_name, then by field name. Both keys are
         *     identifier-whitelisted at request time against `dataset_manifest` and
         *     `field_manifest`. Wire-shape is a URL-encoded JSON string passed via
         *     the `?filters=` query parameter (max 16 KiB).
         */
        FiltersByDB: {
            [key: string]: {
                [key: string]: components["schemas"]["FilterSpec"];
            };
        };
    };
    responses: {
        /** @description Invalid query parameter or filter shape. */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /**
         * @description The `{v}` path segment does not match the running artifact. Clients
         *     should refetch `/api/version` (advertised via the `Location` header)
         *     and retry against the new version.
         */
        StaleArtifactVersion: {
            headers: {
                /** @description Always `/api/version`. */
                Location?: string;
                [name: string]: unknown;
            };
            content: {
                "text/plain": string;
            };
        };
    };
    parameters: {
        /**
         * @description Artifact version (e.g. `2026-05-12.1`). Must equal the running
         *     artifact's `artifactVersion`; otherwise the endpoint returns 410.
         */
        ArtifactVersion: string;
        /**
         * @description URL-encoded JSON object of shape `FiltersByDB` (see schema). The raw
         *     string is capped at 16 KiB before unmarshal to prevent DoS.
         */
        Filters: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
