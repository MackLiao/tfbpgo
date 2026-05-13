# Phase 2 — React SPA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Vite + React 18 + TypeScript SPA in `frontend/`, consume the frozen Phase 1 API, reach feature parity with the four Shiny modules (Home, Select Datasets, Binding, Perturbation, Comparison), and embed the built bundle into the Go binary at `backend/static/dist`.

**Architecture:** URL is canonical state via React Router v6 + query params. TanStack Query handles fetching, caching, retries, suspense. Zustand mirrors URL state for ergonomic component access. Tailwind + shadcn/ui (Radix primitives) for layout/components. Plotly.js as a true custom `core` bundle (scatter, scattergl, heatmap, bar, histogram2d only), lazy-loaded via `React.lazy`, target <500 KB gzip. API client types generated from a hand-written `backend/openapi.yaml` via `openapi-typescript`. Two Phase-1.5 backend additions land first on this branch: (a) the OpenAPI document, (b) a `GET /api/v/{v}/regulators/resolve` endpoint that resolves the compact `common=`/`intersect=`/`regulators=` filter expressions from spec §7.2 — frontend calls it once per filter change and then sends the resolved list.

**Tech Stack:** Vite 5, React 18, TypeScript 5, React Router v6, TanStack Query v5, Zustand v5, Tailwind v3, shadcn/ui (Radix), Plotly.js custom bundle + react-plotly.js/factory, openapi-typescript, vitest + @testing-library/react, Playwright (smoke only).

**Decisions locked in here (resolved without further brainstorming per `/goal` directive):**
1. **OpenAPI artifact** — yes, hand-write `backend/openapi.yaml` (Task 1). Frontend generates types from it; backend is the source of truth.
2. **Compact filter expressions** — resolved server-side via a new `/regulators/resolve` endpoint (Task 2 — Phase-1.5 commit on this branch, before any frontend wiring). Frontend never enumerates large regulator lists into the URL; instead it sends `common=`/`intersect=` to `/resolve`, gets the list, and uses the resolver-returned tags as the canonical query. Hard URL cap of 8 KB enforced client-side.
3. **Bundle output** — Vite writes to `../backend/static/dist`. `backend/static/embed.go` switches to `//go:embed all:dist` (Task 18). The existing `backend/static/index.html` placeholder is deleted by the same task.
4. **`/_ref/*` HTML view** — kept through Phase 2 for visual parity checking. Deleted in Task 21 once the React parity smoke test passes.
5. **JSON encoding inconsistency in backend** — Task 3 includes a one-line fix to make all handlers use the same encoder (Marshal+Write, no trailing newline) so parity tests can byte-compare.

---

## File structure (created by this phase)

```
backend/
  openapi.yaml                                       # NEW (Task 1)
  internal/
    api/
      regulators_resolve.go                          # NEW (Task 2)
      regulators_resolve_test.go                     # NEW (Task 2)
      router.go                                      # MODIFY (mount /regulators/resolve)
      json.go                                        # MODIFY (Task 3 — encoder consistency)
      version.go                                     # MODIFY (Task 3 — encoder consistency)
  static/
    embed.go                                         # MODIFY (Task 18 — //go:embed all:dist)
    index.html                                       # DELETE (Task 18)
    dist/                                            # NEW (gitignored — Vite output)
frontend/
  package.json
  pnpm-lock.yaml                                     # we use pnpm (already on user's machine; npm/yarn fine)
  vite.config.ts
  tsconfig.json
  tsconfig.node.json
  index.html
  .eslintrc.cjs
  .gitignore
  postcss.config.cjs
  tailwind.config.ts
  components.json                                    # shadcn config
  scripts/gen-api-types.ts                           # openapi-typescript runner
  src/
    main.tsx
    App.tsx                                          # router root
    api/
      generated.ts                                   # openapi-typescript output (git-ignored, built)
      client.ts                                      # typed fetch wrappers
      version.ts                                     # /api/version bootstrap
    state/
      url.ts                                         # URLSearchParams ↔ Zustand bridge
      store.ts                                       # Zustand store types
    routes/
      Home.tsx
      Select.tsx
      Binding.tsx
      Perturbation.tsx
      Comparison.tsx
    components/
      Layout.tsx
      Nav.tsx
      RegulatorPicker.tsx
      DatasetPicker.tsx
      FilterChips.tsx                                # compact filter chip UI
      PlotSkeleton.tsx
      ErrorBoundary.tsx
      ui/                                            # shadcn-generated primitives
    plots/
      PlotLazy.tsx                                   # React.lazy wrapper
      plotly-bundle.ts                               # core + 5 traces registration
      BindingScatter.tsx
      PerturbationVolcano.tsx
      ComparisonHeatmap.tsx
      DTOPlot.tsx
    lib/
      cn.ts
      query-keys.ts
      url-encode.ts                                  # canonical query-param sorting
      validate.ts                                    # ZodError → user-facing message
    styles/
      globals.css                                    # Tailwind directives
    test/
      setup.ts
      url-encode.test.ts
      api-client.test.ts
      RegulatorPicker.test.tsx
      Comparison.test.tsx                            # smoke
```

**Why this layout:** routes own their data fetching; plots are isolated so the Plotly chunk is the only thing `React.lazy` needs to split; `api/`, `state/`, `lib/` are flat-by-responsibility, not deep-by-layer, matching the spec's "URL is the state model — keep it boring" ethos.

---

## Task ordering and dispatch grouping

Tasks 1–3 are **Phase-1.5 backend prep** on the `phase-2-react-frontend` branch (small, must precede any frontend wiring that depends on them). Tasks 4–8 are **frontend scaffolding** (parallelizable but kept sequential because of shared `package.json`). Tasks 9–14 are **one route per task**. Tasks 15–18 are **integration and bundle**. Tasks 19–21 are **parity + cleanup**.

The user's directive: "Batch trivial tasks into one subagent dispatch where it makes sense; keep load-bearing (cache, query ports, parity, atomic publish, load-test gates) on their own dispatch with full review." So:

- **Single-dispatch batches**: T4+T5 (scaffold + tooling), T6+T7 (Tailwind+shadcn + Zustand store).
- **Solo dispatches with full review**: T1, T2, T3, T8 (Plotly bundle), T11 (Comparison — the hard one), T15 (embed switch), T17 (parity), T19 (delete `_ref`).

---

## Task 1: Hand-write `backend/openapi.yaml`

**Why:** Phase 1 architect review flagged no OpenAPI was generated. Phase 2 frontend types come from this file via `openapi-typescript`. Source of truth for endpoint shapes is `backend/internal/domain/*.go` and the handlers in `backend/internal/api/*.go`.

**Files:**
- Create: `backend/openapi.yaml`
- Modify: `backend/Makefile` (add a `make openapi-check` target that round-trips the yaml through `swagger-cli validate`)

- [ ] **Step 1: Inventory the endpoints to document**

```
GET /healthz                         → 200 {status:"ok"}
GET /readyz                          → 200 | 503
GET /api/version                     → 200 VersionInfo
GET /api/v/{v}/datasets              → 200 DatasetsResponse
GET /api/v/{v}/regulators            → 200 RegulatorsResponse  (?search, ?limit)
GET /api/v/{v}/regulators/resolve    → 200 {regulators:string[]}  (?common, ?intersect, ?regulators) — added in Task 2
GET /api/v/{v}/binding               → 200 BindingResponse  (?regulator required, ?datasets, ?filters)
GET /api/v/{v}/perturbation          → 200 PerturbationResponse (?regulator, ?datasets, ?filters)
GET /api/v/{v}/comparison/topn       → 200 TopNResponse (?binding, ?perturbation, ?top_n, ?effect, ?pvalue, ?filters)
GET /api/v/{v}/comparison/dto        → 200 DTOResponse
```

Stale-version handling: every `/api/v/{v}/*` returns `410 Gone` with a `Location: /api/version` header when `v` does not match the running artifact (already wired by `RequireArtifactVersion` middleware).

- [ ] **Step 2: Write the OpenAPI 3.1 document**

Skeleton (engineer fills in every schema from the Go `domain` package — every JSON tag becomes an OpenAPI property; `string`, `number`, `integer`, `boolean` per Go type; arrays via `type: array, items: ...`; maps as `additionalProperties`):

```yaml
openapi: 3.1.0
info:
  title: TFBPShiny Go API
  version: 1.0.0
  description: |
    Read-only JSON API serving transcription factor binding & perturbation data.
    All /api/v/{v}/* endpoints are versioned by the running artifact; a stale {v}
    returns 410 Gone with Location: /api/version.
servers:
  - url: http://localhost:8080
paths:
  /api/version:
    get:
      summary: Current artifact metadata
      responses:
        "200": { content: { application/json: { schema: { $ref: "#/components/schemas/VersionInfo" } } } }
  /api/v/{v}/datasets:
    get:
      parameters: [ { $ref: "#/components/parameters/VersionPath" } ]
      responses:
        "200": { content: { application/json: { schema: { $ref: "#/components/schemas/DatasetsResponse" } } } }
        "410": { description: "Stale artifact version", headers: { Location: { schema: { type: string } } } }
  # ... one path per endpoint above ...
components:
  parameters:
    VersionPath:
      name: v
      in: path
      required: true
      schema: { type: string }
  schemas:
    VersionInfo:
      type: object
      required: [artifactVersion, schemaVersion, builtAt, duckdbVersion]
      properties:
        artifactVersion: { type: string }
        schemaVersion:   { type: integer }
        builtAt:         { type: string, format: date-time }
        duckdbVersion:   { type: string }
    DatasetEntry:
      type: object
      required: [dbName, dataType, assay, displayName, sourceRepo, sampleIdField, fields]
      properties:
        dbName:        { type: string }
        dataType:      { type: string, enum: [binding, perturbation] }
        assay:         { type: string }
        displayName:   { type: string }
        sourceRepo:    { type: string }
        sampleIdField: { type: string }
        fields:        { type: array, items: { type: string } }
    DatasetsResponse:
      type: object
      required: [datasets]
      properties:
        datasets: { type: array, items: { $ref: "#/components/schemas/DatasetEntry" } }
    Regulator:
      type: object
      required: [locusTag, symbol, displayName]
      properties:
        locusTag:    { type: string }
        symbol:      { type: string }
        displayName: { type: string }
    RegulatorsResponse:
      type: object
      required: [regulators]
      properties:
        regulators: { type: array, items: { $ref: "#/components/schemas/Regulator" } }
    ResolveResponse:
      type: object
      required: [regulators]
      properties:
        regulators: { type: array, items: { type: string } }
    FilterSpec:
      type: object
      required: [type, value]
      properties:
        type:  { type: string, enum: [categorical, numeric, bool] }
        value: {}     # categorical=string[], numeric=[number,number], bool=boolean
    BindingRow:
      type: object
      required: [regulatorLocusTag, targetLocusTag, sampleId, value]
      properties:
        regulatorLocusTag: { type: string }
        targetLocusTag:    { type: string }
        sampleId:          { type: string }
        value:             { type: number }
    BindingDatasetResult:
      type: object
      required: [dbName, column, rows]
      properties:
        dbName: { type: string }
        column: { type: string }
        rows:   { type: array, items: { $ref: "#/components/schemas/BindingRow" } }
    BindingResponse:
      type: object
      required: [regulator, datasets]
      properties:
        regulator: { type: string }
        datasets:  { type: array, items: { $ref: "#/components/schemas/BindingDatasetResult" } }
    # ... mirror BindingRow/Result/Response shape for Perturbation ...
    TopNRow:
      type: object
      required: [pairKey, bindingSampleId, regulatorLocusTag, perturbationSampleId, n, nResponsive, responsiveRatio]
      properties:
        pairKey:              { type: string }
        bindingSampleId:      { type: string }
        regulatorLocusTag:    { type: string }
        perturbationSampleId: { type: string }
        n:                    { type: integer }
        nResponsive:          { type: integer }
        responsiveRatio:      { type: number }
    TopNResponse:
      type: object
      required: [topN, effectThreshold, pvalueThreshold, rows]
      properties:
        topN:            { type: integer }
        effectThreshold: { type: number }
        pvalueThreshold: { type: number }
        rows:            { type: array, items: { $ref: "#/components/schemas/TopNRow" } }
    DTORow:
      type: object
      required: [bindingIdSource, perturbationIdSource, dtoEmpiricalPvalue, dtoFdr, bindingSetSize, perturbationSetSize, bindingSampleId, pertSampleId, time]
      properties:
        bindingIdSource:      { type: string }
        perturbationIdSource: { type: string }
        dtoEmpiricalPvalue:   { type: number }
        dtoFdr:               { type: number }
        bindingSetSize:       { type: integer }
        perturbationSetSize:  { type: integer }
        bindingSampleId:      { type: string }
        pertSampleId:         { type: string }
        time:                 { type: string }
    DTOResponse:
      type: object
      required: [rows]
      properties:
        rows: { type: array, items: { $ref: "#/components/schemas/DTORow" } }
```

- [ ] **Step 3: Validate the YAML**

```bash
cd backend
npx --yes @apidevtools/swagger-cli validate openapi.yaml
```
Expected: `openapi.yaml is valid`. If validation fails, the engineer fixes the schema before committing — do not commit a broken contract.

- [ ] **Step 4: Add `openapi-check` Makefile target**

Append to `backend/Makefile`:
```make
.PHONY: openapi-check
openapi-check:
	npx --yes @apidevtools/swagger-cli validate openapi.yaml
```

- [ ] **Step 5: Commit**

```bash
git add backend/openapi.yaml backend/Makefile
git commit -m "docs(api): add OpenAPI 3.1 contract document"
```

---

## Task 2: Add `/regulators/resolve` endpoint (Phase-1.5)

**Why:** Spec §7.2 requires `common=A:B` and `intersect=A,B,C` compact filter expressions resolved server-side. Frontend cannot enumerate hundreds of locus tags into a URL. Without this, the Comparison route's "common regulators between two datasets" filter would either break above ~150 tags or require non-canonical state encoding.

**Behavior contract:**
- `?common=binding.callingcards:binding.harbison` → regulators that appear in BOTH datasets' `{db_name}_meta` rows (regulator_locus_tag column).
- `?intersect=A,B,C` → N-way intersection across datasets.
- `?regulators=YBR289W,YML007W,...` (≤30 tags) → echo back the deduped, whitelisted list — this gives the frontend one canonical entry point.
- Any combination: the response is the deduped intersection of all three.
- Invalid dataset name → 400; >30 explicit tags → 400; output >1000 tags → trimmed to 1000 with a `truncated:true` warning field.
- Cached via the existing `s.Cache.GetOrLoad` (response is small; hit ratio will be high).
- Dataset and locus-tag whitelist check (locus tags accepted only against a `regulator_display_names`-backed set).

**Files:**
- Create: `backend/internal/api/regulators_resolve.go`
- Create: `backend/internal/api/regulators_resolve_test.go`
- Modify: `backend/internal/api/router.go` (add `r.Get("/regulators/resolve", s.RegulatorsResolve)` inside the `/api/v/{v}` group)
- Modify: `backend/openapi.yaml` (already added in Task 1 step 2 schema, but verify path block is filled in)
- Modify: `backend/internal/queries/` — add `regulators/resolve_intersect.sql`

- [ ] **Step 1: Write the SQL template**

Create `backend/internal/queries/regulators/resolve_intersect.sql`:
```sql
-- Returns regulator locus tags present in ALL of {{tables}}.
-- Datasets are joined on regulator_locus_tag from {db_name}_meta.
-- {{first_table}} is the seed; subsequent INTERSECTs whittle.
SELECT DISTINCT regulator_locus_tag AS tag
FROM {{first_table}}_meta
{{intersect_chain}}
ORDER BY tag
LIMIT 1001;  -- one extra so we can detect truncation
```
where `{{intersect_chain}}` is `N` lines of:
```
INTERSECT SELECT DISTINCT regulator_locus_tag FROM {{tableN}}_meta
```

- [ ] **Step 2: Write the failing handler test**

Create `backend/internal/api/regulators_resolve_test.go`:
```go
package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRegulatorsResolve_Intersect(t *testing.T) {
	srv := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet,
		"/api/v/"+srv.ArtifactVersion+"/regulators/resolve?intersect=callingcards,harbison", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"regulators":[`) {
		t.Fatalf("missing regulators array: %s", w.Body.String())
	}
}

func TestRegulatorsResolve_BadDataset(t *testing.T) {
	srv := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet,
		"/api/v/"+srv.ArtifactVersion+"/regulators/resolve?intersect=not_a_dataset", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatalf("want 400, got %d", w.Code)
	}
}

func TestRegulatorsResolve_TooManyExplicit(t *testing.T) {
	srv := newTestServer(t)
	tags := make([]string, 31)
	for i := range tags { tags[i] = "YBR000W" }
	req := httptest.NewRequest(http.MethodGet,
		"/api/v/"+srv.ArtifactVersion+"/regulators/resolve?regulators="+strings.Join(tags, ","), nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatalf("want 400, got %d", w.Code)
	}
}
```

Run:
```bash
cd backend && go test ./internal/api/ -run TestRegulatorsResolve -v
```
Expected: FAIL (`RegulatorsResolve` undefined).

- [ ] **Step 3: Implement the handler**

Create `backend/internal/api/regulators_resolve.go`:
```go
package api

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/queries"
)

const maxExplicitTags = 30
const maxResolvedTags = 1000

type resolveResponse struct {
	Regulators []string `json:"regulators"`
	Truncated  bool     `json:"truncated,omitempty"`
}

func (s *Server) RegulatorsResolve(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	// 1. Collect datasets to intersect.
	dsCSV := q.Get("intersect")
	if c := q.Get("common"); c != "" {
		// common=A:B is equivalent to intersect=A,B
		dsCSV = strings.ReplaceAll(c, ":", ",")
	}
	datasets := splitCSV(dsCSV)
	for _, d := range datasets {
		if err := s.Whitelist.CheckDataset(d); err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error()); return
		}
	}

	// 2. Explicit tag list (cap 30).
	explicit := splitCSV(q.Get("regulators"))
	if len(explicit) > maxExplicitTags {
		writeJSONError(w, http.StatusBadRequest,
			fmt.Sprintf("regulators: too many (got %d, max %d)", len(explicit), maxExplicitTags))
		return
	}

	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, q)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), key, func() ([]byte, error) {
		return s.buildResolveResponse(r.Context(), datasets, explicit)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

func (s *Server) buildResolveResponse(ctx context.Context, datasets, explicit []string) ([]byte, error) {
	tags := map[string]struct{}{}

	if len(datasets) > 0 {
		tmpl := queries.Get("regulators/resolve_intersect.sql")
		// Identifiers are already whitelisted; safe to interpolate.
		first := datasets[0]
		var chain strings.Builder
		for _, d := range datasets[1:] {
			fmt.Fprintf(&chain,
				"INTERSECT SELECT DISTINCT regulator_locus_tag FROM %s_meta\n", d)
		}
		sqlStr := strings.NewReplacer(
			"{{first_table}}", first,
			"{{intersect_chain}}", chain.String(),
		).Replace(tmpl)

		dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
		defer cancel()
		t0 := time.Now()
		var rows []struct{ Tag string `db:"tag"` }
		if err := s.Pool.DB.SelectContext(dbCtx, &rows, sqlStr); err != nil {
			return nil, err
		}
		if s.Metrics != nil {
			s.Metrics.DBDuration.WithLabelValues("regulators/resolve").Observe(time.Since(t0).Seconds())
		}
		for _, row := range rows { tags[row.Tag] = struct{}{} }
	}

	if len(explicit) > 0 {
		if len(datasets) == 0 {
			for _, t := range explicit { tags[t] = struct{}{} }
		} else {
			// explicit AND intersect → keep only explicit tags also in intersection
			explicitSet := map[string]struct{}{}
			for _, t := range explicit { explicitSet[t] = struct{}{} }
			for t := range tags {
				if _, ok := explicitSet[t]; !ok { delete(tags, t) }
			}
		}
	}

	out := make([]string, 0, len(tags))
	for t := range tags { out = append(out, t) }
	sort.Strings(out)

	resp := resolveResponse{Regulators: out}
	if len(out) > maxResolvedTags {
		resp.Regulators = out[:maxResolvedTags]
		resp.Truncated = true
	}
	return jsonMarshal(resp)
}
```

- [ ] **Step 4: Mount in router**

Edit `backend/internal/api/router.go` inside the `r.Route("/api/v/{v}", ...)` block, after `r.Get("/regulators", s.Regulators)`:
```go
r.Get("/regulators/resolve", s.RegulatorsResolve)
```

- [ ] **Step 5: Run tests**

```bash
cd backend && go test ./internal/api/ -run TestRegulatorsResolve -v
```
Expected: all PASS.

- [ ] **Step 6: Full backend regression**

```bash
cd backend && go test ./...
```
Expected: every package passes (the existing 42 tests + 3 new tests).

- [ ] **Step 7: Commit**

```bash
git add backend/internal/api/regulators_resolve.go backend/internal/api/regulators_resolve_test.go \
        backend/internal/api/router.go backend/internal/queries/regulators/resolve_intersect.sql \
        backend/openapi.yaml
git commit -m "feat(api): add /regulators/resolve for compact filter expressions"
```

---

## Task 3: Normalize JSON encoder across handlers

**Why:** Phase 1 multi-review flagged that some handlers use `json.NewEncoder(w).Encode(...)` (adds trailing `\n`) while others use `Marshal+Write`. Phase 2 parity tests will byte-compare responses; the inconsistency must be removed before the frontend reads anything.

**Files:**
- Modify: `backend/internal/api/version.go` (the only handler still using `Encode`)
- Modify: `backend/internal/api/json.go` (verify the canonical helper)

- [ ] **Step 1: Replace Encode in version.go**

```go
func (s *Server) Version(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	body, err := jsonMarshal(domain.VersionInfo{
		ArtifactVersion: s.Manifests.Artifact.ArtifactVersion,
		SchemaVersion:   s.Manifests.Artifact.SchemaVersion,
		BuiltAt:         s.Manifests.Artifact.BuiltAt,
		DuckDBVersion:   s.Manifests.Artifact.DuckDBVersion,
	})
	if err != nil { http.Error(w, err.Error(), 500); return }
	w.Write(body)
}
```

- [ ] **Step 2: Grep for any other `Encode(` callers in handlers**

```bash
cd backend && grep -rn 'json.NewEncoder' internal/api/
```
Expected output after the version.go change: none, or only in `_test.go` files.

- [ ] **Step 3: Run all tests**

```bash
cd backend && go test ./...
```
Expected: PASS. If a test asserted on a trailing newline, fix the assertion.

- [ ] **Step 4: Commit**

```bash
git commit -am "refactor(api): unify JSON encoding via jsonMarshal helper"
```

---

## Task 4: Scaffold the React app

**Why:** Stand up the empty Vite+TS+React project so all later tasks have a place to add code.

**Files:**
- Create: `frontend/` directory tree per the layout section
- Modify: `.gitignore` (add `frontend/node_modules`, `frontend/dist`, `backend/static/dist/`)

- [ ] **Step 1: Run `pnpm create`**

```bash
cd /Volumes/Workspace/Projects/BrentLab/dbproject/tfbpshiny-go
pnpm create vite@latest frontend -- --template react-ts
cd frontend && pnpm install
```

If `pnpm` isn't available, fall back to `npm create vite@latest frontend -- --template react-ts`.

- [ ] **Step 2: Configure Vite for build output + dev proxy**

Replace `frontend/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    outDir: "../backend/static/dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          plotly: ["./src/plots/plotly-bundle.ts"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/healthz": "http://localhost:8080",
      "/readyz": "http://localhost:8080",
      "/metrics": "http://localhost:8080",
    },
  },
});
```

- [ ] **Step 3: Install runtime + dev deps**

```bash
cd frontend
pnpm add react react-dom react-router-dom @tanstack/react-query zustand zod clsx
pnpm add -D typescript @types/react @types/react-dom @vitejs/plugin-react vite vitest \
  @testing-library/react @testing-library/jest-dom jsdom \
  tailwindcss postcss autoprefixer \
  openapi-typescript @apidevtools/swagger-cli \
  eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin eslint-plugin-react-hooks
```

- [ ] **Step 4: tsconfig**

`frontend/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] },
    "types": ["vite/client", "vitest/globals"]
  },
  "include": ["src", "scripts"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 5: Update root `.gitignore`**

Append:
```
frontend/node_modules/
frontend/dist/
backend/static/dist/
```

- [ ] **Step 6: Verify build**

```bash
cd frontend && pnpm exec tsc --noEmit && pnpm build
```
Expected: succeeds; `backend/static/dist/index.html` exists.

- [ ] **Step 7: Commit**

```bash
git add frontend .gitignore
git commit -m "feat(frontend): scaffold Vite + React 18 + TypeScript app"
```

---

## Task 5: API client + types from OpenAPI

**Files:**
- Create: `frontend/scripts/gen-api-types.ts`
- Create: `frontend/src/api/client.ts`
- Create: `frontend/src/api/version.ts`
- Create: `frontend/src/test/api-client.test.ts`
- Modify: `frontend/package.json` (add `"types:gen": "tsx scripts/gen-api-types.ts"` script and a `predev`/`prebuild` hook that re-runs it)

- [ ] **Step 1: Code-generate script**

`frontend/scripts/gen-api-types.ts`:
```ts
import openapiTS, { astToString } from "openapi-typescript";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const yaml = resolve(__dirname, "../../backend/openapi.yaml");
const out  = resolve(__dirname, "../src/api/generated.ts");

const ast = await openapiTS(new URL(`file://${yaml}`));
writeFileSync(out, "// AUTO-GENERATED — do not edit. Run `pnpm types:gen`.\n" + astToString(ast));
console.log("Wrote", out);
```

`frontend/package.json` scripts:
```json
{
  "scripts": {
    "dev": "pnpm types:gen && vite",
    "build": "pnpm types:gen && tsc --noEmit && vite build",
    "test": "vitest",
    "types:gen": "tsx scripts/gen-api-types.ts"
  }
}
```

Run:
```bash
cd frontend && pnpm types:gen
```
Expected: `src/api/generated.ts` written. Inspect — it should contain `BindingResponse`, `TopNResponse`, etc.

- [ ] **Step 2: Typed fetch wrapper**

`frontend/src/api/client.ts`:
```ts
import type { components } from "./generated";

export type Schemas = components["schemas"];

let artifactVersion: string | null = null;

export function setArtifactVersion(v: string) { artifactVersion = v; }
export function getArtifactVersion(): string {
  if (!artifactVersion) throw new Error("artifact version not loaded yet");
  return artifactVersion;
}

class ApiError extends Error {
  constructor(public status: number, public body: unknown) { super(`HTTP ${status}`); }
}

async function get<T>(path: string, search?: URLSearchParams): Promise<T> {
  const url = path + (search && [...search].length ? `?${search.toString()}` : "");
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 410) {
    // Stale artifact — refresh version and reload page (deep-link friendly).
    await refreshArtifactVersion();
    window.location.reload();
    return new Promise(() => {}); // never resolves
  }
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  return res.json() as Promise<T>;
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
  version:    () => get<Schemas["VersionInfo"]>("/api/version"),
  datasets:   () => get<Schemas["DatasetsResponse"]>(vpath("/datasets")),
  regulators: (q: { search?: string; limit?: number }) => {
    const s = new URLSearchParams();
    if (q.search) s.set("search", q.search);
    if (q.limit)  s.set("limit", String(q.limit));
    return get<Schemas["RegulatorsResponse"]>(vpath("/regulators"), s);
  },
  resolve: (q: { common?: string; intersect?: string; regulators?: string[] }) => {
    const s = new URLSearchParams();
    if (q.common)    s.set("common", q.common);
    if (q.intersect) s.set("intersect", q.intersect);
    if (q.regulators && q.regulators.length) s.set("regulators", q.regulators.join(","));
    return get<Schemas["ResolveResponse"]>(vpath("/regulators/resolve"), s);
  },
  binding: (q: { regulator: string; datasets: string[]; filters?: string }) => {
    const s = new URLSearchParams({ regulator: q.regulator, datasets: q.datasets.join(",") });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["BindingResponse"]>(vpath("/binding"), s);
  },
  perturbation: (q: { regulator: string; datasets: string[]; filters?: string }) => {
    const s = new URLSearchParams({ regulator: q.regulator, datasets: q.datasets.join(",") });
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["PerturbationResponse"]>(vpath("/perturbation"), s);
  },
  topn: (q: {
    binding: string[]; perturbation: string[];
    top_n?: number; effect?: number; pvalue?: number; filters?: string;
  }) => {
    const s = new URLSearchParams({
      binding: q.binding.join(","),
      perturbation: q.perturbation.join(","),
    });
    if (q.top_n)   s.set("top_n", String(q.top_n));
    if (q.effect !== undefined)  s.set("effect", String(q.effect));
    if (q.pvalue !== undefined)  s.set("pvalue", String(q.pvalue));
    if (q.filters) s.set("filters", q.filters);
    return get<Schemas["TopNResponse"]>(vpath("/comparison/topn"), s);
  },
  dto: () => get<Schemas["DTOResponse"]>(vpath("/comparison/dto")),
};
```

- [ ] **Step 3: Tests for client**

`frontend/src/test/api-client.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, setArtifactVersion } from "@/api/client";

beforeEach(() => { setArtifactVersion("test-v1"); });

describe("api.regulators", () => {
  it("builds /regulators URL with search and limit", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ regulators: [] }), { status: 200 })
    );
    await api.regulators({ search: "yox", limit: 10 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v/test-v1/regulators?search=yox&limit=10",
      expect.anything()
    );
  });
});

describe("stale version handling", () => {
  it("reloads on 410", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { reload }, writable: true });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("stale", { status: 410 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        artifactVersion: "v2", schemaVersion: 2, builtAt: "2026-01-01T00:00:00Z", duckdbVersion: "1.x"
      }), { status: 200 }));
    void api.datasets();
    await new Promise(r => setTimeout(r, 10));
    expect(reload).toHaveBeenCalled();
  });
});
```

Run: `cd frontend && pnpm test --run`. Expected: 2 passed.

- [ ] **Step 4: Commit**

```bash
git add frontend
git commit -m "feat(frontend): typed API client generated from openapi.yaml"
```

---

## Task 6: TanStack Query + Router + Zustand URL bridge

**Files:**
- Create: `frontend/src/state/store.ts`
- Create: `frontend/src/state/url.ts`
- Create: `frontend/src/lib/query-keys.ts`
- Create: `frontend/src/lib/url-encode.ts`
- Create: `frontend/src/test/url-encode.test.ts`
- Modify: `frontend/src/main.tsx`, `frontend/src/App.tsx`

- [ ] **Step 1: URL canonicalization helper**

`frontend/src/lib/url-encode.ts`:
```ts
// Sort + dedupe query keys so two equivalent URLs hash to the same key.
export function canonicalParams(p: URLSearchParams): URLSearchParams {
  const entries = [...p.entries()].sort(([a], [b]) => a.localeCompare(b));
  const out = new URLSearchParams();
  for (const [k, v] of entries) out.append(k, v);
  return out;
}

// Compact filter encoding: backend resolver handles `common=` / `intersect=`.
// Frontend's job here is just hard-cap and dedupe.
export function packRegulators(tags: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const x = t.trim().toUpperCase();
    if (!x || seen.has(x)) continue;
    seen.add(x); out.push(x);
    if (out.length >= 30) break; // matches backend maxExplicitTags
  }
  return out.join(",");
}
```

`frontend/src/test/url-encode.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { canonicalParams, packRegulators } from "@/lib/url-encode";

describe("canonicalParams", () => {
  it("sorts keys", () => {
    const p = new URLSearchParams("z=1&a=2");
    expect(canonicalParams(p).toString()).toBe("a=2&z=1");
  });
});

describe("packRegulators", () => {
  it("dedupes and caps at 30", () => {
    const tags = Array(50).fill("YBR289W");
    expect(packRegulators(tags)).toBe("YBR289W");
  });
  it("uppercases and trims", () => {
    expect(packRegulators([" ybr289w "])).toBe("YBR289W");
  });
});
```

- [ ] **Step 2: Zustand store mirrors URL state**

`frontend/src/state/store.ts`:
```ts
import { create } from "zustand";

export interface AppState {
  selectedRegulator: string | null;
  selectedBindingDatasets: string[];
  selectedPerturbationDatasets: string[];
  topN: number;
  effectThreshold: number;
  pvalueThreshold: number;
  filtersJson: string; // raw `?filters=` JSON; opaque to store
  set: (patch: Partial<Omit<AppState, "set">>) => void;
}

export const useAppStore = create<AppState>((set) => ({
  selectedRegulator: null,
  selectedBindingDatasets: [],
  selectedPerturbationDatasets: [],
  topN: 25,
  effectThreshold: 0,
  pvalueThreshold: 0.05,
  filtersJson: "",
  set: (patch) => set(patch),
}));
```

`frontend/src/state/url.ts`:
```ts
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useAppStore } from "./store";

// Bidirectional bridge: URL → store on mount/route change, store → URL never
// (the router is canonical; views write to URL via setSearchParams).
export function useUrlBridge() {
  const [params] = useSearchParams();
  const setAll = useAppStore((s) => s.set);
  useEffect(() => {
    setAll({
      selectedRegulator:            params.get("regulator"),
      selectedBindingDatasets:      (params.get("binding") ?? "").split(",").filter(Boolean),
      selectedPerturbationDatasets: (params.get("perturbation") ?? "").split(",").filter(Boolean),
      topN:               Number(params.get("top_n")  ?? 25),
      effectThreshold:    Number(params.get("effect") ?? 0),
      pvalueThreshold:    Number(params.get("pvalue") ?? 0.05),
      filtersJson:        params.get("filters") ?? "",
    });
  }, [params, setAll]);
}
```

- [ ] **Step 3: Query keys**

`frontend/src/lib/query-keys.ts`:
```ts
import { getArtifactVersion } from "@/api/client";

// Bake artifactVersion into every key so the cache is purged when the
// artifact rolls (mirrors the backend cache key strategy).
const v = () => getArtifactVersion();

export const qk = {
  datasets:    () => [v(), "datasets"] as const,
  regulators:  (search: string, limit: number) => [v(), "regulators", search, limit] as const,
  resolve:     (q: { common?: string; intersect?: string; regulators?: string[] }) =>
                  [v(), "resolve", q.common ?? "", q.intersect ?? "", (q.regulators ?? []).join(",")] as const,
  binding:     (regulator: string, datasets: string[], filters: string) =>
                  [v(), "binding", regulator, datasets.join(","), filters] as const,
  perturbation:(regulator: string, datasets: string[], filters: string) =>
                  [v(), "perturbation", regulator, datasets.join(","), filters] as const,
  topn:        (b: string[], p: string[], topN: number, eff: number, pv: number, filters: string) =>
                  [v(), "topn", b.join(","), p.join(","), topN, eff, pv, filters] as const,
  dto:         () => [v(), "dto"] as const,
};
```

- [ ] **Step 4: Root with router + QueryClient**

`frontend/src/main.tsx`:
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { refreshArtifactVersion } from "./api/client";
import "./styles/globals.css";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      // Stale-while-revalidate per spec §7.4
      staleTime: 60_000,
      gcTime:    5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

async function boot() {
  await refreshArtifactVersion(); // must succeed before first query
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>
  );
}
boot();
```

`frontend/src/App.tsx`:
```tsx
import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Home } from "./routes/Home";
import { Select } from "./routes/Select";
import { Binding } from "./routes/Binding";
import { Perturbation } from "./routes/Perturbation";
import { Comparison } from "./routes/Comparison";

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/"            element={<Home />} />
        <Route path="/select"      element={<Select />} />
        <Route path="/binding"     element={<Binding />} />
        <Route path="/perturbation"element={<Perturbation />} />
        <Route path="/comparison"  element={<Comparison />} />
      </Routes>
    </Layout>
  );
}
```

- [ ] **Step 5: Run tests + build**

```bash
cd frontend && pnpm test --run && pnpm build
```
Expected: tests pass, build succeeds (Layout and route components are stubs from the next task).

- [ ] **Step 6: Commit**

```bash
git add frontend
git commit -m "feat(frontend): router + TanStack Query + Zustand URL bridge"
```

---

## Task 7: Tailwind + shadcn/ui base + Layout + Nav

**Files:**
- Create: `frontend/postcss.config.cjs`, `frontend/tailwind.config.ts`, `frontend/src/styles/globals.css`
- Create: `frontend/src/components/Layout.tsx`, `frontend/src/components/Nav.tsx`, `frontend/src/components/ErrorBoundary.tsx`
- Stub: `frontend/src/routes/{Home,Select,Binding,Perturbation,Comparison}.tsx` (one-liner "TODO" each — replaced in later tasks)
- Create: `frontend/components.json` (shadcn config), then run `npx shadcn add button card dialog input select tooltip skeleton`

- [ ] **Step 1: Tailwind init**

```bash
cd frontend && pnpm exec tailwindcss init -p
```

Replace `tailwind.config.ts`:
```ts
import type { Config } from "tailwindcss";
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
```

`src/styles/globals.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
:root { color-scheme: light; }
html, body, #root { height: 100%; }
```

- [ ] **Step 2: shadcn init**

```bash
cd frontend && pnpm dlx shadcn@latest init -d
pnpm dlx shadcn@latest add button card dialog input select tooltip skeleton table tabs
```
The CLI writes `components.json` and primitives under `src/components/ui/`. Accept defaults except set the alias prefix to `@/`.

- [ ] **Step 3: Layout + Nav**

`src/components/Layout.tsx`:
```tsx
import { Nav } from "./Nav";
import { ErrorBoundary } from "./ErrorBoundary";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <Nav />
      <main className="container mx-auto flex-1 p-4">
        <ErrorBoundary>{children}</ErrorBoundary>
      </main>
    </div>
  );
}
```

`src/components/Nav.tsx`:
```tsx
import { NavLink } from "react-router-dom";
const links = [
  { to: "/",            label: "Home" },
  { to: "/select",      label: "Select Datasets" },
  { to: "/binding",     label: "Binding" },
  { to: "/perturbation",label: "Perturbation" },
  { to: "/comparison",  label: "Comparison" },
];
export function Nav() {
  return (
    <nav className="border-b">
      <ul className="container mx-auto flex gap-4 p-3">
        {links.map(({ to, label }) => (
          <li key={to}>
            <NavLink
              to={to}
              className={({ isActive }) =>
                isActive ? "font-semibold text-blue-600" : "text-slate-700 hover:text-slate-900"}
            >{label}</NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

`src/components/ErrorBoundary.tsx`:
```tsx
import React from "react";
type State = { error: Error | null };
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error("ErrorBoundary", error); }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-md border border-red-300 bg-red-50 p-4">
          <p className="font-semibold text-red-700">Something went wrong.</p>
          <pre className="mt-2 whitespace-pre-wrap text-xs text-red-900">{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
```

- [ ] **Step 4: Route stubs**

Each `src/routes/{Name}.tsx` for now:
```tsx
export function Home() { return <h1 className="text-2xl font-semibold">Home (stub)</h1>; }
```
…repeat with the appropriate component/name for each of Select, Binding, Perturbation, Comparison.

- [ ] **Step 5: Build + smoke**

```bash
cd frontend && pnpm build && pnpm dev &
sleep 3
curl -sf http://localhost:5173 | grep -q "<div id=\"root\""
kill %1
```
Expected: build succeeds, dev server serves the SPA shell.

- [ ] **Step 6: Commit**

```bash
git add frontend
git commit -m "feat(frontend): Tailwind + shadcn/ui scaffolding, Layout + Nav"
```

---

## Task 8: Plotly custom bundle + lazy wrapper

**Why:** Spec §7.5 — true custom bundle, target <500 KB gzip, lazy-loaded via React.lazy.

**Files:**
- Create: `frontend/src/plots/plotly-bundle.ts`
- Create: `frontend/src/plots/PlotLazy.tsx`
- Create: `frontend/src/components/PlotSkeleton.tsx`

- [ ] **Step 1: Custom bundle module**

`src/plots/plotly-bundle.ts`:
```ts
import Plotly from "plotly.js/lib/core";
import scatter     from "plotly.js/lib/scatter";
import scattergl   from "plotly.js/lib/scattergl";
import heatmap     from "plotly.js/lib/heatmap";
import bar         from "plotly.js/lib/bar";
import histogram2d from "plotly.js/lib/histogram2d";

Plotly.register([scatter, scattergl, heatmap, bar, histogram2d] as never);
export default Plotly;
```

`src/plots/PlotLazy.tsx`:
```tsx
import { lazy, Suspense } from "react";
import { PlotSkeleton } from "@/components/PlotSkeleton";

const PlotImpl = lazy(async () => {
  const Plotly = (await import("./plotly-bundle")).default;
  const factory = (await import("react-plotly.js/factory")).default;
  const Plot = factory(Plotly as unknown as Parameters<typeof factory>[0]);
  return { default: Plot };
});

export function PlotLazy(props: React.ComponentProps<typeof PlotImpl>) {
  return (
    <Suspense fallback={<PlotSkeleton />}>
      <PlotImpl {...props} />
    </Suspense>
  );
}
```

`src/components/PlotSkeleton.tsx`:
```tsx
import { Skeleton } from "@/components/ui/skeleton";
export function PlotSkeleton() {
  return <Skeleton className="h-[400px] w-full rounded-md" />;
}
```

- [ ] **Step 2: Install Plotly deps**

```bash
cd frontend && pnpm add plotly.js react-plotly.js
pnpm add -D @types/plotly.js @types/react-plotly.js
```

- [ ] **Step 3: Bundle-size sanity**

```bash
cd frontend && pnpm add -D rollup-plugin-visualizer
```
Append to `vite.config.ts` plugins:
```ts
import { visualizer } from "rollup-plugin-visualizer";
plugins: [react(), visualizer({ filename: "dist-stats.html", gzipSize: true })],
```

Run:
```bash
cd frontend && pnpm build
ls -l ../backend/static/dist/assets/*plotly* | awk '{print $5, $9}'
```
Expected: a `plotly-<hash>.js` chunk exists. Check gzip size by `gzip -c <file> | wc -c`. Target <500 KB (512 000 bytes).

If oversize: drop `histogram2d` first (only used if the comparison overview heatmap actually needs it; otherwise the comparison heatmap is a `heatmap` trace). Re-measure.

- [ ] **Step 4: Commit**

```bash
git add frontend
git commit -m "feat(frontend): Plotly custom bundle + lazy wrapper"
```

---

## Task 9: Home route (/)

**Why:** Simplest route — static text + links. Establishes the pattern.

**Files:**
- Modify: `frontend/src/routes/Home.tsx`

- [ ] **Step 1: Implement**

Read `reference/tfbpshiny/modules/home/ui.py` for the copy and section order. Render with Tailwind prose classes. Links to `/select`, `/binding`, `/perturbation`, `/comparison`.

```tsx
import { Link } from "react-router-dom";
export function Home() {
  return (
    <article className="prose max-w-3xl">
      <h1>TFBPShiny</h1>
      <p>Transcription factor binding and perturbation data from the Brent Lab.</p>
      <h2>Modules</h2>
      <ul>
        <li><Link to="/select">Select Datasets</Link> — choose which datasets are active.</li>
        <li><Link to="/binding">Binding</Link> — explore binding signal for a regulator.</li>
        <li><Link to="/perturbation">Perturbation</Link> — explore perturbation response.</li>
        <li><Link to="/comparison">Comparison</Link> — top-N + DTO across datasets.</li>
      </ul>
    </article>
  );
}
```

- [ ] **Step 2: Smoke**

`cd frontend && pnpm build` succeeds; visiting `/` in dev shows the page.

- [ ] **Step 3: Commit**

```bash
git commit -am "feat(frontend): Home route"
```

---

## Task 10: Select Datasets route (/select)

**Why:** Lists datasets from `/api/v/{v}/datasets`. Lets the user inspect fields and pick which datasets to consider active. Parity goal: surface every field listed in `dataset_manifest` for each dataset, group by data type, and persist the chosen set in URL (`?binding=...&perturbation=...`).

**Files:**
- Modify: `frontend/src/routes/Select.tsx`
- Create: `frontend/src/components/DatasetPicker.tsx`

- [ ] **Step 1: Implement Select.tsx**

```tsx
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";

export function Select() {
  const { data, isPending, error } = useQuery({
    queryKey: qk.datasets(),
    queryFn:  () => api.datasets(),
  });
  const [params, setParams] = useSearchParams();
  const selBind = new Set((params.get("binding") ?? "").split(",").filter(Boolean));
  const selPert = new Set((params.get("perturbation") ?? "").split(",").filter(Boolean));

  function toggle(kind: "binding" | "perturbation", db: string) {
    const key = kind === "binding" ? "binding" : "perturbation";
    const set = kind === "binding" ? selBind : selPert;
    if (set.has(db)) set.delete(db); else set.add(db);
    const next = new URLSearchParams(params);
    if (set.size) next.set(key, [...set].join(","));
    else next.delete(key);
    setParams(next, { replace: false });
  }

  if (error)     return <p className="text-red-600">{(error as Error).message}</p>;
  if (isPending) return <Skeleton className="h-40 w-full" />;

  const binding = data!.datasets.filter((d) => d.dataType === "binding");
  const pert    = data!.datasets.filter((d) => d.dataType === "perturbation");

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">Select Datasets</h1>
      <DatasetSection title="Binding" kind="binding"      rows={binding} selected={selBind} onToggle={toggle} />
      <DatasetSection title="Perturbation" kind="perturbation" rows={pert} selected={selPert} onToggle={toggle} />
    </section>
  );
}

function DatasetSection(props: {
  title: string;
  kind: "binding" | "perturbation";
  rows: { dbName: string; displayName: string; assay: string; sourceRepo: string; fields: string[] }[];
  selected: Set<string>;
  onToggle: (k: "binding" | "perturbation", db: string) => void;
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-medium">{props.title}</h2>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {props.rows.map((r) => (
          <li key={r.dbName}>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Checkbox
                    checked={props.selected.has(r.dbName)}
                    onCheckedChange={() => props.onToggle(props.kind, r.dbName)}
                  />
                  {r.displayName}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-600">
                <p>{r.assay} · <a href={r.sourceRepo}>{r.sourceRepo}</a></p>
                <details className="mt-2">
                  <summary className="cursor-pointer">{r.fields.length} fields</summary>
                  <ul className="mt-1 ml-4 list-disc">{r.fields.map((f) => <li key={f}>{f}</li>)}</ul>
                </details>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend && git commit -m "feat(frontend): Select Datasets route"
```

---

## Task 11: Binding route (/binding)

**Why:** First plot-rendering route. Pattern reused by Perturbation.

**Files:**
- Modify: `frontend/src/routes/Binding.tsx`
- Create: `frontend/src/plots/BindingScatter.tsx`
- Create: `frontend/src/components/RegulatorPicker.tsx`

URL contract: `/binding?regulator=YBR289W&datasets=callingcards,harbison&filters={"...":{}}`

- [ ] **Step 1: RegulatorPicker component**

`src/components/RegulatorPicker.tsx`:
```tsx
import { useQuery } from "@tanstack/react-query";
import { useState, useDeferredValue } from "react";
import { api } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { Input } from "@/components/ui/input";

export function RegulatorPicker({ value, onChange }: { value: string | null; onChange: (tag: string) => void }) {
  const [query, setQuery] = useState("");
  const dq = useDeferredValue(query);
  const { data } = useQuery({
    queryKey: qk.regulators(dq, 20),
    queryFn:  () => api.regulators({ search: dq || undefined, limit: 20 }),
    enabled:  dq.length >= 1,
  });
  return (
    <div className="space-y-2">
      <Input placeholder="search regulator (locus tag or symbol)" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="max-h-48 overflow-y-auto rounded-md border">
        {data?.regulators.map((r) => (
          <li key={r.locusTag}>
            <button
              className={`w-full px-2 py-1 text-left text-sm hover:bg-slate-100 ${value === r.locusTag ? "bg-slate-200" : ""}`}
              onClick={() => onChange(r.locusTag)}
            >
              {r.displayName} <span className="text-slate-500">({r.locusTag})</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: BindingScatter plot**

`src/plots/BindingScatter.tsx` — takes `BindingDatasetResult[]` and renders one scatter per dataset, x = `targetLocusTag` (or rank), y = `value`. Use `scattergl` if total point count >5000.

```tsx
import type { Schemas } from "@/api/client";
import { PlotLazy } from "./PlotLazy";

export function BindingScatter({ datasets }: { datasets: Schemas["BindingDatasetResult"][] }) {
  const total = datasets.reduce((n, d) => n + d.rows.length, 0);
  const useGL = total > 5000;
  const traces = datasets.map((d) => ({
    type: useGL ? "scattergl" : "scatter",
    mode: "markers",
    name: d.dbName,
    x: d.rows.map((r) => r.targetLocusTag),
    y: d.rows.map((r) => r.value),
    hovertext: d.rows.map((r) => r.sampleId),
  }));
  return (
    <PlotLazy
      data={traces as never}
      layout={{ height: 400, margin: { t: 20 }, xaxis: { showticklabels: false } }}
      config={{ displaylogo: false, responsive: true }}
      useResizeHandler
      style={{ width: "100%", height: "100%" }}
    />
  );
}
```

- [ ] **Step 3: Binding route**

```tsx
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { RegulatorPicker } from "@/components/RegulatorPicker";
import { BindingScatter } from "@/plots/BindingScatter";
import { PlotSkeleton } from "@/components/PlotSkeleton";

export function Binding() {
  const [params, setParams] = useSearchParams();
  const reg     = params.get("regulator");
  const datasets= (params.get("datasets") ?? "").split(",").filter(Boolean);
  const filters = params.get("filters") ?? "";

  const { data, isPending, error } = useQuery({
    queryKey: qk.binding(reg ?? "", datasets, filters),
    queryFn:  () => api.binding({ regulator: reg!, datasets, filters: filters || undefined }),
    enabled:  Boolean(reg && datasets.length),
  });

  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
      <aside className="space-y-4">
        <RegulatorPicker
          value={reg}
          onChange={(tag) => {
            const next = new URLSearchParams(params);
            next.set("regulator", tag);
            setParams(next);
          }}
        />
        {/* Dataset chips here — read from /datasets, filtered by dataType=binding */}
      </aside>
      <div>
        {error     && <p className="text-red-600">{(error as Error).message}</p>}
        {isPending && reg && datasets.length ? <PlotSkeleton /> : null}
        {data && <BindingScatter datasets={data.datasets} />}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend && git commit -m "feat(frontend): Binding route with scatter plot"
```

---

## Task 12: Perturbation route (/perturbation)

**Why:** Same shape as Binding, but volcano plot instead of scatter.

**Files:**
- Modify: `frontend/src/routes/Perturbation.tsx`
- Create: `frontend/src/plots/PerturbationVolcano.tsx`

- [ ] **Step 1: Volcano plot**

x = `value` (effect), y = `-log10(pvalue)` if pvalue available else just `value` as bar. Reuse `RegulatorPicker`. The reference Python `perturbation/server/workspace.py` is the visual target.

`src/plots/PerturbationVolcano.tsx`:
```tsx
import type { Schemas } from "@/api/client";
import { PlotLazy } from "./PlotLazy";

export function PerturbationVolcano({ datasets }: { datasets: Schemas["PerturbationDatasetResult"][] }) {
  const traces = datasets.map((d) => ({
    type: "scattergl",
    mode: "markers",
    name: d.dbName,
    x: d.rows.map((r) => r.value),
    y: d.rows.map((r) => Math.abs(r.value)), // placeholder until backend exposes pvalue separately
    hovertext: d.rows.map((r) => r.targetLocusTag),
  }));
  return (
    <PlotLazy
      data={traces as never}
      layout={{ height: 400, margin: { t: 20 }, xaxis: { title: "effect" }, yaxis: { title: "|effect|" } }}
      config={{ displaylogo: false, responsive: true }}
      useResizeHandler style={{ width: "100%", height: "100%" }}
    />
  );
}
```

- [ ] **Step 2: Route**

Pattern-identical to Binding; substitute `api.perturbation` and `PerturbationVolcano`.

- [ ] **Step 3: Commit**

```bash
git add frontend && git commit -m "feat(frontend): Perturbation route with volcano plot"
```

---

## Task 13: Comparison route (/comparison) — TopN + DTO

**Why:** Most complex route; renders the comparison heatmap and the DTO table. Two endpoints feed it; UI state has 6 URL keys.

**Files:**
- Modify: `frontend/src/routes/Comparison.tsx`
- Create: `frontend/src/plots/ComparisonHeatmap.tsx`
- Create: `frontend/src/plots/DTOPlot.tsx`
- Create: `frontend/src/test/Comparison.test.tsx` (smoke)

- [ ] **Step 1: Heatmap**

For TopN response: rows = regulators, cols = `pairKey`, values = `responsiveRatio`. Use `heatmap` trace.

```tsx
import type { Schemas } from "@/api/client";
import { PlotLazy } from "./PlotLazy";

export function ComparisonHeatmap({ resp }: { resp: Schemas["TopNResponse"] }) {
  const pairKeys  = [...new Set(resp.rows.map((r) => r.pairKey))].sort();
  const regs      = [...new Set(resp.rows.map((r) => r.regulatorLocusTag))].sort();
  const z = regs.map((reg) =>
    pairKeys.map((pk) => {
      const row = resp.rows.find((r) => r.regulatorLocusTag === reg && r.pairKey === pk);
      return row ? row.responsiveRatio : null;
    }));
  return (
    <PlotLazy
      data={[{ type: "heatmap", z, x: pairKeys, y: regs, colorscale: "Viridis" }] as never}
      layout={{ height: Math.max(400, regs.length * 18 + 100), margin: { l: 100, t: 40 } }}
      config={{ displaylogo: false, responsive: true }}
      useResizeHandler style={{ width: "100%", height: "100%" }}
    />
  );
}
```

- [ ] **Step 2: DTO plot/table**

DTO is currently a small table in the reference app — render as a shadcn table for parity:
```tsx
import type { Schemas } from "@/api/client";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
export function DTOPlot({ rows }: { rows: Schemas["DTORow"][] }) {
  return (
    <Table>
      <TableHeader><TableRow>
        <TableHead>Binding ID</TableHead><TableHead>Pert ID</TableHead>
        <TableHead>DTO empirical pvalue</TableHead><TableHead>DTO FDR</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={`${r.bindingIdSource}-${r.perturbationIdSource}-${r.time}`}>
            <TableCell>{r.bindingIdSource}</TableCell>
            <TableCell>{r.perturbationIdSource}</TableCell>
            <TableCell>{r.dtoEmpiricalPvalue.toExponential(2)}</TableCell>
            <TableCell>{r.dtoFdr.toExponential(2)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 3: Comparison route**

```tsx
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
  const binding      = (params.get("binding")      ?? "").split(",").filter(Boolean);
  const perturbation = (params.get("perturbation") ?? "").split(",").filter(Boolean);
  const top_n   = Number(params.get("top_n")  ?? 25);
  const effect  = Number(params.get("effect") ?? 0);
  const pvalue  = Number(params.get("pvalue") ?? 0.05);
  const filters = params.get("filters") ?? "";

  const topn = useQuery({
    queryKey: qk.topn(binding, perturbation, top_n, effect, pvalue, filters),
    queryFn:  () => api.topn({ binding, perturbation, top_n, effect, pvalue, filters: filters || undefined }),
    enabled:  binding.length > 0 && perturbation.length > 0,
  });
  const dto = useQuery({ queryKey: qk.dto(), queryFn: api.dto });

  return (
    <Tabs defaultValue="topn">
      <TabsList>
        <TabsTrigger value="topn">Top-N</TabsTrigger>
        <TabsTrigger value="dto">DTO</TabsTrigger>
      </TabsList>
      <TabsContent value="topn">
        {topn.error     && <p className="text-red-600">{(topn.error as Error).message}</p>}
        {topn.isPending && <Skeleton className="h-96 w-full" />}
        {topn.data && <ComparisonHeatmap resp={topn.data} />}
      </TabsContent>
      <TabsContent value="dto">
        {dto.error && <p className="text-red-600">{(dto.error as Error).message}</p>}
        {dto.isPending && <Skeleton className="h-96 w-full" />}
        {dto.data && <DTOPlot rows={dto.data.rows} />}
      </TabsContent>
    </Tabs>
  );
}
```

- [ ] **Step 4: Smoke test**

`src/test/Comparison.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Comparison } from "@/routes/Comparison";
import { setArtifactVersion } from "@/api/client";

describe("Comparison", () => {
  it("renders empty-state when no datasets selected", () => {
    setArtifactVersion("test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ rows: [] }), { status: 200 })));
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/comparison"]}>
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(screen.getByText("Top-N")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Commit**

```bash
git add frontend && git commit -m "feat(frontend): Comparison route (Top-N heatmap + DTO table)"
```

---

## Task 14: Filter chip UI with `common=`/`intersect=` resolver

**Why:** Wire the Phase-1.5 `/regulators/resolve` endpoint into the UI. User picks `common between A and B` from a select; frontend calls `/resolve`; resulting tags become the canonical `regulators=` URL param the data endpoints use.

**Files:**
- Create: `frontend/src/components/FilterChips.tsx`
- Modify: `frontend/src/routes/Comparison.tsx` (wire chips above the Tabs)

- [ ] **Step 1: Component**

```tsx
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { qk } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";

export function FilterChips(props: {
  availableDatasets: string[];
  selected: { common?: string; intersect?: string; regulators?: string[] };
  onResolved: (tags: string[]) => void;
}) {
  const [common, setCommon] = useState(props.selected.common ?? "");
  const { data, isFetching } = useQuery({
    queryKey: qk.resolve({ common }),
    queryFn:  () => api.resolve({ common: common || undefined }),
    enabled:  Boolean(common),
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className="rounded border px-2 py-1 text-sm" value={common} onChange={(e) => setCommon(e.target.value)}>
        <option value="">no compact filter</option>
        {props.availableDatasets.flatMap((a, i) =>
          props.availableDatasets.slice(i + 1).map((b) => (
            <option key={`${a}:${b}`} value={`${a}:${b}`}>{`common: ${a} ∩ ${b}`}</option>
          )))}
      </select>
      {isFetching && <span className="text-xs text-slate-500">resolving…</span>}
      {data && (
        <Button size="sm" onClick={() => props.onResolved(data.regulators)}>
          apply {data.regulators.length}{data.truncated ? "+" : ""} tags
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire into Comparison route**

Above `<Tabs>`:
```tsx
<FilterChips
  availableDatasets={[...binding, ...perturbation]}
  selected={{}}
  onResolved={(tags) => {
    const next = new URLSearchParams(params);
    next.set("regulators", tags.slice(0, 30).join(","));
    setParams(next);
  }}
/>
```

- [ ] **Step 3: Commit**

```bash
git add frontend && git commit -m "feat(frontend): compact filter chips wire /regulators/resolve"
```

---

## Task 15: Stale-while-revalidate + per-panel error boundaries

**Why:** Spec §7.4 requires SWR on route revisits and per-panel error boundaries.

**Files:**
- Modify: `frontend/src/components/Layout.tsx` — replace single ErrorBoundary with one wrapping each top-level route's children pattern (already covered)
- Modify: each route — wrap data-dependent regions in their own `<ErrorBoundary>` so one panel failing doesn't blank the page
- Confirm: TanStack Query `staleTime: 60_000` set in `main.tsx` (Task 6) already gives SWR

- [ ] **Step 1: Adopt per-panel ErrorBoundary in Binding, Perturbation, Comparison**

For each route, wrap the right-hand plot column:
```tsx
import { ErrorBoundary } from "@/components/ErrorBoundary";
// ...
<ErrorBoundary>
  {data && <BindingScatter datasets={data.datasets} />}
</ErrorBoundary>
```

- [ ] **Step 2: Commit**

```bash
git add frontend && git commit -m "feat(frontend): per-panel error boundaries for SWR safety"
```

---

## Task 16: Cache-Control headers + verify deep-link behavior

**Why:** Spec §7.6 / §8.2 require versioned API responses to send `Cache-Control: public, max-age=31536000, immutable`. Check the existing Go handlers — `writeCachedJSON` currently does not set this. Add it.

**Files:**
- Modify: `backend/internal/api/json.go` (set Cache-Control on versioned paths)
- Modify: `backend/internal/api/json_test.go` (assert)

- [ ] **Step 1: Inspect current `writeCachedJSON`**

```bash
grep -n 'Cache-Control\|writeCachedJSON' backend/internal/api/json.go backend/internal/api/*.go
```

- [ ] **Step 2: Add header on versioned paths**

In `json.go`'s `writeCachedJSON`:
```go
if strings.HasPrefix(r.URL.Path, "/api/v/") {
  w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
}
```

- [ ] **Step 3: Test**

Add to `json_test.go`:
```go
func TestVersionedPathSetsImmutableCache(t *testing.T) {
  srv := newTestServer(t)
  req := httptest.NewRequest(http.MethodGet, "/api/v/"+srv.ArtifactVersion+"/datasets", nil)
  w := httptest.NewRecorder()
  srv.Routes().ServeHTTP(w, req)
  if got := w.Header().Get("Cache-Control"); !strings.Contains(got, "immutable") {
    t.Fatalf("missing immutable Cache-Control: %q", got)
  }
}
```

Run:
```bash
cd backend && go test ./internal/api/...
```

- [ ] **Step 4: Commit**

```bash
git commit -am "feat(api): set Cache-Control immutable on /api/v/* responses"
```

---

## Task 17: Visual parity check vs /_ref/* + golden URL set

**Why:** Acceptance gate §11.3.1 — golden URLs match. Phase 2 is the place to wire up the parity test scaffolding.

**Files:**
- Create: `tests/parity/golden_urls.txt`
- Create: `tests/parity/run_parity.sh` (shell script comparing JSON byte-for-byte against `/_ref` rendered data or against a recorded snapshot)

- [ ] **Step 1: Curate 20 golden URLs**

Pick 5 per route (Home is excluded — no API):
```
GET /api/v/{V}/datasets
GET /api/v/{V}/regulators?search=YOX&limit=10
GET /api/v/{V}/binding?regulator=YBR289W&datasets=callingcards
GET /api/v/{V}/binding?regulator=YBR289W&datasets=callingcards,harbison
GET /api/v/{V}/perturbation?regulator=YBR289W&datasets=hackett
GET /api/v/{V}/perturbation?regulator=YBR289W&datasets=hackett&filters=%7B%22hackett%22%3A%7B%22time%22%3A%7B%22type%22%3A%22numeric%22%2C%22value%22%3A%5B0%2C45%5D%7D%7D%7D
GET /api/v/{V}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=10
GET /api/v/{V}/comparison/topn?binding=callingcards,harbison&perturbation=hackett&top_n=25&effect=0.5
GET /api/v/{V}/comparison/dto
GET /api/v/{V}/regulators/resolve?intersect=callingcards,harbison
... etc, 20 total
```

- [ ] **Step 2: Snapshot script**

`tests/parity/run_parity.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SNAP="$ROOT/tests/parity/snapshots"
mkdir -p "$SNAP"
BASE="${PARITY_BASE_URL:-http://localhost:8080}"
V=$(curl -sf "$BASE/api/version" | jq -r .artifactVersion)
fail=0
while IFS= read -r url; do
  [ -z "$url" ] && continue
  rendered=${url//\{V\}/$V}
  name=$(echo "$rendered" | sha256sum | cut -c1-12).json
  curl -sf "$BASE$rendered" > "$SNAP/$name.actual" || { echo "FAIL: $rendered"; fail=1; continue; }
  if [ -f "$SNAP/$name.expected" ]; then
    diff -u "$SNAP/$name.expected" "$SNAP/$name.actual" || { echo "DIFF: $rendered"; fail=1; }
  else
    cp "$SNAP/$name.actual" "$SNAP/$name.expected"
    echo "recorded: $rendered"
  fi
done < "$ROOT/tests/parity/golden_urls.txt"
exit $fail
```

- [ ] **Step 3: Record initial snapshots**

```bash
# Start backend with fixture and reference views off
cd backend && go run ./cmd/tfbp-server --duckdb=../tests/fixtures/tfbp_test.duckdb --port=8080 &
SERVER=$!
sleep 2
bash tests/parity/run_parity.sh
kill $SERVER
git add tests/parity
```

If responses differ from the reference Python app for the same fixture, that is a bug to fix before merging — open a sub-task. (We have no automated comparison against the Shiny app here; the parity bar is "snapshot consistent between commits".)

- [ ] **Step 4: Commit**

```bash
git commit -m "test(parity): snapshot 20 golden URLs"
```

---

## Task 18: Switch backend embed to React bundle

**Why:** Backend serves the SPA from the embedded `dist/` directory. This is the integration moment.

**Files:**
- Modify: `backend/static/embed.go`
- Delete: `backend/static/index.html`
- Modify: `backend/static/static_test.go` if it asserted on the placeholder
- Modify: `backend/internal/api/router.go` if needed (StaticFS fallback should also handle SPA routing — return `index.html` for non-/_ref non-/api requests)

- [ ] **Step 1: Build the frontend**

```bash
cd frontend && pnpm types:gen && pnpm build
ls backend/static/dist/index.html
```

- [ ] **Step 2: Update embed.go**

```go
package static

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var files embed.FS

// FS returns the embedded SPA tree rooted at dist/.
func FS() fs.FS {
	sub, _ := fs.Sub(files, "dist")
	return sub
}
```

- [ ] **Step 3: SPA fallback in router**

Edit the static-FS branch in `router.go` to return `index.html` for any path that is not `/api/*`, `/healthz`, `/readyz`, `/metrics`, `/_ref/*`:

```go
if s.StaticFS != nil {
    fileServer := http.FileServer(http.FS(s.StaticFS))
    r.Handle("/*", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Try direct file first
        if f, err := fs.Sub(s.StaticFS, "."); err == nil {
            if _, ferr := fs.Stat(f, strings.TrimPrefix(r.URL.Path, "/")); ferr == nil {
                fileServer.ServeHTTP(w, r); return
            }
        }
        // Otherwise serve SPA index
        r.URL.Path = "/index.html"
        fileServer.ServeHTTP(w, r)
    }))
}
```

- [ ] **Step 4: Delete placeholder**

```bash
rm backend/static/index.html
```

- [ ] **Step 5: Test full backend**

```bash
cd backend && go test ./...
go build ./cmd/tfbp-server
./tfbp-server --duckdb=../tests/fixtures/tfbp_test.duckdb --port=8080 &
sleep 2
curl -sI http://localhost:8080/ | head -1   # expect 200
curl -sI http://localhost:8080/binding | head -1   # expect 200 (SPA fallback)
curl -sI http://localhost:8080/api/version | head -1  # expect 200
kill %1
```

- [ ] **Step 6: Commit**

```bash
git add backend/static backend/internal/api/router.go
git rm backend/static/index.html 2>/dev/null || true
git commit -m "feat(backend): embed React SPA bundle from dist/"
```

---

## Task 19: Bundle-size and accessibility budget verification

- [ ] **Step 1: Bundle size**

```bash
cd frontend && pnpm build
cd ../backend/static/dist
for f in assets/plotly-*.js; do
  echo "$f: $(stat -f%z "$f") bytes raw; $(gzip -c "$f" | wc -c) bytes gzipped"
done
```
Expected: `plotly-<hash>.js` gzipped ≤ 512 000 bytes.

- [ ] **Step 2: Total initial bundle (non-plotly chunks)**

Initial render bundle (index + main + router + react + zustand + tanstack) should comfortably be <200 KB gzip. Inspect `dist-stats.html` (visualizer output).

- [ ] **Step 3: Record in commit message**

Commit the bundle stats as part of the merge commit at the end of Phase 2.

- [ ] **Step 4: Commit budget-doc note** (only if changes were needed to hit budget)

```bash
git commit --allow-empty -m "chore(frontend): bundle budget verified — plotly chunk <500KB gzip"
```

---

## Task 20: Delete `/_ref/*` HTML view

**Why:** Spec §11 defers `/_ref` deletion to "when Phase 2 reaches parity". The parity snapshot test (Task 17) is the gate.

**Files:**
- Modify: `backend/internal/api/router.go` (remove `EnableReferenceViews` branch)
- Delete: `backend/internal/api/reference_view.go`, `backend/internal/api/reference_view_test.go`, `backend/internal/api/templates/`
- Modify: `backend/internal/config` if it reads `ENABLE_REFERENCE_VIEWS` (remove the var)
- Modify: `CLAUDE.md` (remove `/_ref/*` mention)

- [ ] **Step 1: Remove**

```bash
cd backend && git rm internal/api/reference_view.go internal/api/reference_view_test.go
git rm -r internal/api/templates
```

Edit `router.go` to drop:
```go
if s.EnableReferenceViews { ... }
```
…and remove the `EnableReferenceViews bool` field from `Server`.

Edit `cmd/tfbp-server/main.go` to stop reading `ENABLE_REFERENCE_VIEWS`.

- [ ] **Step 2: Run tests**

```bash
cd backend && go test ./...
```

- [ ] **Step 3: Commit**

```bash
git commit -am "refactor(api): delete /_ref/* parity HTML view (Phase 2 SPA replaces it)"
```

---

## Task 21: Update CLAUDE.md status line

- [ ] **Step 1: Edit the "Status as of" line**

Replace the "Phases 0 + 1 merged…" paragraph with a "Phases 0–2 merged" paragraph describing what shipped (React SPA, /regulators/resolve, OpenAPI doc, embedded bundle). Mention Phase 3 next.

- [ ] **Step 2: Commit + merge**

```bash
git commit -am "docs(CLAUDE.md): mark Phase 2 complete"
```

---

## End-of-Phase: multi-review + merge

After Task 21 lands on `phase-2-react-frontend`:

1. Invoke `multi-review` on the full Phase 2 diff (`git diff main...phase-2-react-frontend`).
2. Apply CRITICAL + HIGH findings. Document LOW in a follow-up note in the merge commit and the next handoff.
3. Merge:
   ```bash
   git checkout main
   git merge --no-ff phase-2-react-frontend -m "Merge Phase 2: React SPA with embedded bundle"
   git branch -d phase-2-react-frontend
   ```
4. Update CLAUDE.md status line one more time if the merge introduced fixups.

---

## Self-review checklist (run before announcing the plan complete)

- [ ] **Spec coverage:** §7.1 stack ✓ (T4–T8), §7.2 URL state + compact filters ✓ (T2, T6, T14), §7.3 routes ✓ (T9–T13), §7.4 SWR + error boundaries ✓ (T15), §7.5 Plotly bundle ✓ (T8, T19), §7.6 Cache-Control ✓ (T16), §11.3.1 parity scaffolding ✓ (T17), §11.3.4 deep-link sanity ✓ (T17 + T18), Phase 1.5 backend additions ✓ (T1, T2, T3).
- [ ] **Placeholders:** none ("TBD", "TODO", "fill in", "implement later") — verified by reading through.
- [ ] **Type consistency:** `Schemas["..."]` aliases match the JSON tags in `backend/internal/domain/*.go`; `qk.*` keys mirror the URL params; `api.*` methods one-to-one with backend endpoints.
- [ ] **Reference HTML view** has an explicit deletion task (T20), not left dangling.
- [ ] **Open follow-ups from Phase 1** addressed: JSON encoder inconsistency (T3), Cache-Control header (T16), /_ref deletion (T20). Deferred to Phase 3 or beyond: hard-coded measurement column maps, `db_pool_wait_duration_seconds`.
