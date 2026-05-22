# Phase C — Continuation Run Summary

**Branch:** `auto/overnight-phase-a` (continued; no fork)
**Phase C started:** 2026-05-22 ~05:00 PDT (after morning hand-off)
**Phase C finished:** 2026-05-22 09:56 PDT
**Cumulative commits (A + B + C):** 40 (HEAD = `97028ae`)
**Cumulative diff vs main:** 111 files, +14 487 / −693

---

## Phase C tasks DONE (9 / 9)

| ID | Title                                              | Lead commit | Review fix-up |
|----|----------------------------------------------------|-------------|---------------|
| C1 | schema_version=4 — unlock deferred items           | `602d479`   | `5c2e23f`     |
| C2 | Home module rebuild                                | `b887de0`   | —             |
| C3 | Binding/Perturbation P1 polish                     | `3e4b80a`   | —             |
| C4 | Select Datasets — schema-v4-dependent features     | `d3acce8`   | —             |
| C5 | Select Datasets — remaining UX features            | `0eab148`   | —             |
| C6 | Export endpoint + tarball UI                       | `d0bcd24`   | —             |
| C7 | Multi-review nice-to-haves cleanup                 | `ae93dc4`   | —             |
| C8 | Plotly bundle recovery                             | `06fa0c0`   | —             |
| C9 | Performance — corr → UNION-ALL                     | `00036f2`   | —             |

## What's now closed in the audits

- **`docs/parity/home.md`** — P1 rows 6–9, 13, plus P2 rows 14–15. The Home
  module now has Bootstrap-style cards with images, NavLink-driven pill
  navigation in wine red, 3-line logo, GitHub badge.
- **`docs/parity/binding.md`** — rows 10, 21, 42 (narrowed picker +
  sample-condition hover) on top of B2's row coverage.
- **`docs/parity/perturbation.md`** — same rows as binding (audit's "same
  shape" parity holds).
- **`docs/parity/comparison.md`** — B1 + A4 already closed the canonical
  rows; nothing further from Phase C.
- **`docs/parity/select_datasets.md`** — rows 1, 3, 4, 9, 12, 14, 15, 18,
  20, 21, 22, 23, 24, 28, 30, 31, 34, 35, 36 closed in Phase C. The
  remaining unclosed rows are mostly P2 or schema-v4-dependent (now
  closed) plus a couple of "future product" items not in the parity
  audit's strict scope.

## Multi-review coverage

Backend milestone (C1) got parallel security + go review; HIGH issues
fixed in `5c2e23f` (json.RawMessage on the wire, six new whitelist tests,
`condition_cols` whitespace trim). C7 swept up the remaining
nice-to-haves from earlier reviews (CHECK constraints, log-warn,
fmt.Errorf wrapping, OpenAPI descriptions, test fidelity, doc cleanup,
`initIntrospect` redesign).

## What's NOT closed (intentional)

- **Cascade narrowing inside filter modal** (audit row 19) — needs a new
  backend endpoint or a precomputed combo cache; deferred. Modal renders
  human-readable level labels but doesn't restrict downstream sets based
  on upstream selections.
- **Per-row reset semantics that span common fields** (audit row 17) —
  partial via the per-field apply-to-all in C5.
- **DTO tab** — explicit "out of scope" per the README; net-new product.
- **Cutover gate** — operator step; not a code task.
- **`FIELD_DESCRIPTIONS` / `FIELD_LEVEL_DEFINITIONS` content** — schema
  is in place after C1 but the Python constants are empty. Operations
  fills these in via a PR when content is ready.

## Sanity check before reviewing

```bash
git checkout auto/overnight-phase-a
cd backend && go build ./... && go test ./... -count=1 -race
cd ../data_prep && poetry run pytest -x
cd ../frontend && pnpm install && pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm exec vite build
cd .. && bash tests/parity/run_parity.sh   # requires backend running on :8080
```

All five were green at the final commit (`97028ae`).

## Suggested merge order

The branch is linear (40 commits, A + B + C history preserved). For a
single PR, merge `auto/overnight-phase-a` → `main` with the existing
history. For staged PRs, the natural cut points are:

1. PR #1: A1–A6 (Phase A backend).
2. PR #2: B1–B4 (Phase B frontend rebuilds).
3. PR #3: C1–C9 (Phase C polish + schema v4).

Backend-only PRs can merge independently of the frontend.

## Recommended next session

1. **Operator-side parity snapshot record** — the snapshot files have
   been auto-recorded along the way (`run_parity.sh` shows 15/15 green
   against a fresh fixture-backed server), but if you change anything
   else, re-run with `PARITY_RECORD=1`.
2. **Curate `FIELD_DESCRIPTIONS` + `FIELD_LEVEL_DEFINITIONS`** in
   `data_prep/src/data_prep/manifests.py`. The runtime endpoints are
   wired to surface them; they're empty until ops fills in.
3. **Cascade narrowing** if the analyst workflow demands it — see
   `polish.md` for the design sketch.
4. **Real-data UX validation** — boot the backend + frontend dev mode
   against a real `tfbp.duckdb` and click through every route. The
   fixture has only one dataset per data_type, so multi-pair flows in
   binding/perturbation/comparison have been tested only at the
   numerical-parity layer, not the visual layer.
