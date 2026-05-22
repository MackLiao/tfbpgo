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
| C3  | Binding/Perturbation P1 polish                     | PENDING     | depends on C1 (condition_cols); narrow RegulatorPicker independent |
| C4  | Select Datasets — schema-v4-dependent features     | PENDING     | depends on C1 |
| C5  | Select Datasets — remaining UX features            | PENDING     | depends on C4 (apply-to-all, sidebar) |
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
