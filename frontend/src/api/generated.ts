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
