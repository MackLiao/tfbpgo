# Phase C — Continuation status

**Branch:** `auto/overnight-phase-a` (continued; no new branch — keeps history linear)
**Started:** 2026-05-22 (continuation of overnight Phase A + B run)
**Source of truth:** `docs/parity/` audits + `docs/parity/auto-status/polish.md`
**Goal:** finish every disparity recorded in the audits + every deferred polish item.

This file mirrors STATUS.md's role for Phase C work. Subagents read it
before starting, append a section before finishing.

---

## Task ledger

| ID  | Title                                              | Status      | Notes |
|-----|----------------------------------------------------|-------------|-------|
| C1  | schema_version=4 — unlock deferred items           | DONE        | foundation: unlocks default-active, description tooltips, cascade narrowing, condition-cols hover, FIELD_TYPE_OVERRIDES via artifact |
| C2  | Home module rebuild                                | DONE        | feature cards + binding/perturbation imgs + wine pill nav + 3-line logo + github badge |
| C3  | Binding/Perturbation P1 polish                     | DONE        | sample-conditions endpoint + overlay hover; ActivePairRegulatorPicker; corr LEFT-JOIN deferred (locus tags only) |
| C4  | Select Datasets — schema-v4-dependent features     | DONE        | rows 1/3/4/9/28 closed; cascade narrowing (row 19) deferred to polish.md |
| C5  | Select Datasets — remaining UX features            | DONE        | apply-to-all + sidebar search/collapse + from_pair + staged Apply (filter modal still writes URL directly per audit §8) |
| C6  | Export endpoint + tarball UI                       | PENDING     | independent; large surface |
| C7  | Multi-review nice-to-haves cleanup                 | PENDING     | independent; small surface across many files |
| C8  | Plotly bundle recovery                             | DONE        | dropped `bar` post-B1; 523→514 KB gzipped |
| C9  | Performance — corr/matrix → UNION-ALL              | PENDING     | independent; benchmark gated |

---

## Activity log

### 2026-05-22 — controller Phase C init
- All Phase A + B tasks DONE on `auto/overnight-phase-a` (22 commits).
- User confirmed go-ahead on finishing remaining disparities via subagent dev.
- 9 new tasks tracked (C1–C9). C1 is the foundation; others gate off it or
  run independently.
- About to dispatch implementer for **Task C1** (schema_version=4 bump).

### 2026-05-22 08:50 PDT — implementer C1
- schema_version 3→4. Seven new columns.
- Go: removed fieldTypeOverrides constant; Kind resolution prefers
  manifest UIKindOverride.
- Datasets endpoint adds defaultActive/defaultFilters/conditionCols;
  fields endpoint adds description/levelDefinitions/uiKindOverride/
  numericLevelSort.
- Regenerated fixture + re-recorded /datasets + /api/version snapshots;
  backfilled four scatter-endpoint .expected snapshots that were
  missing from the prior commit.
- Tests: data_prep pytest ✓ (60 passed), backend go test ./... -race ✓,
  parity ✓ (15/15), frontend tsc --noEmit ✓, vitest ✓ (24 passed).
- Commit: 602d479
- Status: DONE.

### 2026-05-22 08:55 PDT — implementer C8
- Grepped `frontend/src` for `type: "bar"` / `"bar"` usage — none. B1's
  boxplot rebuild eliminated the sole consumer (ComparisonHeatmap).
- Dropped `bar` import + registration from
  `frontend/src/plots/plotly-bundle.ts`; updated comment to record the
  post-B1 trim alongside the histogram2d note.
- Bundle: plotly chunk 1,494.18 kB raw → **514.25 kB gzipped** (down from
  523 KB; ~9 KB recovered, ~2 KB above the 512 KB soft target). polish.md
  A6 entry marked RESOLVED with the residual-2 KB caveat noted; further
  recovery (drop `heatmap`) deferred until `SelectionMatrix` migrates.
- Tests: `pnpm exec tsc --noEmit` ✓, `pnpm exec vitest run` ✓ (24/24),
  `pnpm exec vite build` ✓.
- Status: DONE.

### 2026-05-22 09:05 PDT — implementer C1 multi-review fixes
- defaultFilters/levelDefinitions now json.RawMessage (object on wire,
  not string). OpenAPI + frontend types regenerated.
- Six v4 NewWhitelist Rejects* tests added (closing reviewer IMPORTANT 2):
  unsafe condition_cols entry, oversized default_filters/description/
  level_definitions, out-of-set ui_kind_override/numeric_level_sort.
  Plus whitespace + empty-token rejection on condition_cols CSV.
- condition_cols CSV split trims whitespace consistently in NewWhitelist
  and datasets.go (closes security MEDIUM 1).
- Renamed `maxLevelDefinitionBytes` → `maxLevelDefinitionsBytes`.
- Re-recorded /datasets parity snapshot for the new shape.
- Tests: backend go test ./... -race ✓, data_prep pytest ✓ (60/60),
  frontend tsc + vitest ✓ (24/24), parity ✓ (15/15).
- Commit: 5c2e23f
- Status: C1 multi-review fixes DONE.

### 2026-05-22 09:20 PDT — implementer C4
- Built P1/P2 Select Datasets items unlocked by schema_version=4.
- New files: frontend/src/components/DatasetBreakdownModal.tsx (audit row
  28; modeled on CommonRegulatorsModal — diagonal cell click opens
  `/selection/breakdown`), frontend/src/lib/sort-levels.ts (numeric vs
  lex sort for categorical level labels).
- Modified files: frontend/src/routes/Select.tsx (first-visit defaults
  via useRef-guarded effect — preselects defaultActive datasets and
  seeds defaultFilters when URL has no ?binding=/?perturbation=; sort
  datasets by display_name client-side; wired BreakdownModal),
  frontend/src/components/DatasetFilterModal.tsx (title= on FieldLabel
  for description, levelDefinitions labels on categorical checkboxes,
  numericLevelSort honored), frontend/src/plots/SelectionMatrix.tsx
  (diagonal cells become clickable when onDiagonalClick prop set).
- Polish.md updated with the cascade-narrowing deferral (row 19) and a
  note on dataset-level description tooltips (row 22 — needs schema v5).
- Tests: extended Select.test.tsx with 4 new specs — first-visit
  defaults write URL + filters; URL with ?binding= skips defaults;
  description renders as title=; diagonal click opens breakdown modal
  with mocked response.
- Verify: pnpm types:gen ✓, pnpm exec tsc --noEmit ✓, pnpm exec vitest
  run ✓ (28/28), pnpm exec vite build ✓ (plotly chunk 513.81 KB
  gzipped, no regression).
- Commit: d3acce8
- Status: DONE. Row 19 (cascade narrowing) partial — JSON labels done,
  runtime narrowing deferred.

### 2026-05-22 — implementer C2
- Home module rebuilt to match Shiny `modules/home/ui.py:65-115`:
  Bootstrap-style feature cards via `Card` from `ui/card.tsx`; bold
  wine-red link titles; 100x100 contain-fit images on Binding +
  Perturbation cards. Lead-in re-aligned to "The tabs above…" per
  Shiny copy.
- Assets `binding.png` + `perturbation.png` copied from
  `reference/tfbpshiny/www/` into `frontend/public/`. Vite emits them
  to `backend/static/dist/` as static root assets (verified after
  build); zero JS bundle impact.
- `Nav.tsx`: NavLink retained; replaced text-blue active styling with
  wine-red pill chrome (`bg-wine #722F37` active, `bg-slate-100`
  hover, `rounded-md px-4 py-2`). Added 3-line "TF / Binding &
  Perturbation / Explorer" logo on the left and a GitHub badge
  (octocat SVG + repo label) on the right, hidden below the `sm`
  breakpoint to keep mobile tidy.
- `tailwind.config.ts`: extended `colors.wine = { DEFAULT, hover,
  active }` from Shiny `--color-nav*` CSS variables.
- Files: frontend/src/routes/Home.tsx, frontend/src/components/Nav.tsx,
  frontend/tailwind.config.ts, frontend/public/binding.png,
  frontend/public/perturbation.png.
- Tests: `pnpm exec tsc --noEmit` ✓, `pnpm exec vitest run` ✓ (24/24
  passed), `pnpm exec vite build` ✓ (plotly chunk steady at 514 kB
  gzipped; PNGs land in dist root).
- Acceptance: docs/parity/home.md §2 P1 rows 6–9 and 13 closed; P2
  rows 14 (GitHub badge) and 15 (3-line logo) also addressed.
- Status: DONE.

### 2026-05-22 09:30 PDT — implementer C3
- New endpoint `GET /api/v/{v}/datasets/{db}/sample-conditions` builds
  the `{sample_id: condition_label}` map from dataset_manifest.condition_cols
  (schema v4) — mirrors reference/tfbpshiny/utils/sample_conditions.py:55-94.
  Sample-id join key sourced from manifest.sample_id_field (gm_id for
  callingcards, sample_id otherwise). Identifier safety: per-col
  whitelistedIdent at the SQL site + SafeIdentRE at startup via
  NewWhitelist. CheckField was intentionally skipped because
  hackett.mechanism/restriction live in HIDDEN_FILTER_FIELDS and are
  absent from field_manifest (would 400 every request).
- Overlay hovertext on selected-regulator dots now reads
  `"<symbol><br>r = X.XXX<br><displayA>: <condA><br><displayB>: <condB>"`
  in both BindingCorrBoxplot and PerturbationCorrBoxplot. Every
  DB-sourced string is HTML-escaped via new lib/html-escape.ts (Plotly
  renders hovertext as HTML by default).
- ActivePairRegulatorPicker narrows the regulator selectize to
  regulators present in the corr response. Renders a native <select>
  when < 50 options, typeahead-filtered list otherwise. Mounted in
  Binding + Perturbation sidebars via new optional `regulatorPickerSlot`
  prop on BindingSidebar/PerturbationSidebar; falls back to the global
  RegulatorPicker before corrQuery.data resolves.
- Server-side LEFT JOIN of regulator_display_names into corr response
  was scoped out (4 SQL templates + struct + tests would be a larger
  surface). Corr endpoint is not in golden_urls.txt so no snapshot
  rerecord required. Picker uses bare locus tag labels; future iteration
  can thread regulator symbols when needed.
- Files: backend/internal/api/sample_conditions.go (new),
  backend/internal/api/sample_conditions_test.go (new),
  backend/internal/api/router.go, backend/internal/domain/select_datasets.go,
  backend/openapi.yaml, frontend/src/api/{client,generated}.ts,
  frontend/src/lib/{query-keys,html-escape}.ts (html-escape new),
  frontend/src/components/{ActivePairRegulatorPicker (new),
  BindingSidebar,PerturbationSidebar}.tsx,
  frontend/src/plots/{BindingCorrBoxplot,PerturbationCorrBoxplot}.tsx,
  frontend/src/routes/{Binding,Perturbation}.tsx,
  frontend/src/test/Binding.test.tsx.
- Tests: backend `go build ./... && go test ./... -race` ✓ (4 new
  sample-conditions specs), frontend `pnpm types:gen` ✓,
  `pnpm exec tsc --noEmit` ✓, `pnpm exec vitest run` ✓ (29 tests, 5 in
  Binding.test including new narrowed-picker assertion), `pnpm exec
  vite build` ✓ (plotly chunk 513.81 KB gzipped — no delta),
  `make parity` ✓ 15/15 against fresh local server.
- Commit: 3e4b80a
- Acceptance: docs/parity/binding.md rows 10, 21, 42 (and perturbation
  equivalents).
- Status: DONE.

### 2026-05-22 09:40 PDT — implementer C5
- Closed the remaining Select Datasets UX gaps from
  docs/parity/select_datasets.md §2 rows 12, 14, 15, 18, 20, 21, 23, 24,
  30, 31, 34.
- New file: frontend/src/lib/filter-spec.ts — typed AnnotatedFilterSpec
  helper centralizing the frontend-only `fromPair` annotation. Backend
  ignores unknown JSON fields, so the annotation round-trips through
  `?filters=` without a wire-shape bump.
- DatasetFilterModal: per-field "Apply to all datasets" checkbox shown
  only for categorical/numeric fields that exist across every active
  dataset's field manifest (rows 12, 14). Bool fields intentionally
  excluded — matches Shiny ui.py:63-69. Modal Apply now hands back
  `{next, applyToAllFields}`; the page mirrors flagged specs into every
  other active dataset that has the field. Inline `from_pair` cleanup
  link surfaces on filters carrying the annotation (rows 15, 30).
- CommonRegulatorsModal: `onSelectCommon` now receives `(tags, pair)`
  so the caller can attach the originating display-name pair to the
  resulting `regulator_locus_tag` filter (row 30). Existing `?regulators=`
  side-channel preserved for the Phase B legacy consumers.
- SelectionMatrix: new `highlightedPair` + `onHighlightedClear` props.
  When set, the matrix cell for the originating pair gets an amber
  bg-amber-100 highlight (row 30); clicking the highlighted cell fires
  the clear callback instead of re-opening the common-regulators modal
  (row 31).
- Select.tsx:
  - Staged Apply gate (rows 18, 20, 21): dataset checkbox toggles update
    `pending{Binding,Perturbation}` local state; a sticky page-footer
    "Apply / Reset" pair surfaces only when pending differs from
    committed. Apply commits to URL and clears filter blocks for any
    dataset that was removed (preserves the row-38 contract). Filter
    modal Apply still writes URL directly — smallest-blast-radius
    choice from the task spec / audit §8.
  - Sidebar search box (row 24) — local state, `displayName.toLowerCase()
    .includes(q)` predicate; empty state copy (row 34) "No datasets
    match your search." when query is non-empty and no rows match.
  - Sidebar collapse/expand (row 23) — header chevron toggles
    `?selectSidebar=collapsed|<absent>`. URL state per CLAUDE.md "URL
    is canonical state".
  - useQueries fan-out on the committed-active datasets gives the
    modal the common-fields intersection; the same map drives the
    apply-to-all mirroring + the `regulator_locus_tag` write on
    "Select N common regulators".
  - `activeFromPair` memo finds the from_pair display-name pair in
    `?filters=` and translates back to db_names so the matrix can match
    against rowDb/colDb. `onClearFromPair` removes every
    regulator_locus_tag block carrying the annotation plus the
    `?regulators=` side-channel.
- Tests: 5 new specs in Select.test.tsx — sidebar search filters list +
  empty state; sidebar collapse hides list; staged Apply footer
  appears/disappears with toggles; apply-to-all writes both datasets'
  badges; from_pair URL produces highlighted cell and click-to-clear
  removes both badges.
- Verify: `pnpm exec tsc --noEmit` ✓, `pnpm exec vitest run` ✓ (34/34
  passing; was 29 — 5 new C5 specs), `pnpm exec vite build` ✓ (plotly
  chunk 513.81 KB gzipped, no regression).
- Files: frontend/src/lib/filter-spec.ts (new),
  frontend/src/components/DatasetFilterModal.tsx,
  frontend/src/components/CommonRegulatorsModal.tsx,
  frontend/src/plots/SelectionMatrix.tsx,
  frontend/src/routes/Select.tsx, frontend/src/test/Select.test.tsx.
- Audit rows closed: 12, 14, 15, 18, 20, 21, 23, 24, 30, 31, 34.
- Commit: 0eab148
- Status: DONE.
