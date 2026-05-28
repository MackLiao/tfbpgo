# App-level Chrome & Cross-cutting

**Parity verdict:** Mostly ported faithfully — Home copy, the GitHub badge, error boundaries, per-query loading skeletons, and the manual Plotly layout/config (margins, jitter, hovertemplates, default template) all match Shiny closely. Several "missing" utilities (`plot_formatter.py`, `ratelimit.py`) are **dead code in the current Shiny app**, so their absence is correct — see [non-gaps.md](non-gaps.md). The Go backend's structured request logging + Prometheus metrics is a reasonable functional analog to Shiny's `perf.py`.

There is **one genuine cross-cutting P1**: selection state is lost on in-app navigation. The rest are cosmetic.

## P1

### AC-1 · Selection + filters lost on nav (no shared store; nav/Home links drop the query string)
*(Originally claimed P0; verifier re-scoped to P1 — deep-link/refresh/back-button still carry state, and the numerics are intact once params are present. The break is confined to navigation chrome.)*

In Shiny, the selected datasets + filters are **shared reactive state** automatically present on every tab: `select_datasets_sidebar_server` returns `active_binding_datasets` / `active_perturbation_datasets` / `dataset_filters`, and `app_server` passes those same reactive references into the binding, perturbation, and comparison workspace servers (`app.py:155-231`); switching tabs only flips `active_module` (`:233-290`). Select once → active everywhere.

The React rewrite has **no shared store** — and notably **Zustand is absent from `frontend/package.json` and there are zero `zustand` imports in `src/`**, so the CLAUDE.md "URL + Zustand" claim is false. Selection lives **only** in per-route `useSearchParams` (`Select.tsx:239-260` writes `?binding/?perturbation/?filters`; `Binding.tsx:41-47`, `Perturbation.tsx:42-47`, `Comparison.tsx:33-40` read them). But the global Nav uses bare `<NavLink to="/binding">` path strings (`Nav.tsx:4-10,30-31`) and Home uses bare `<Link to={to}>` (`Home.tsx:25,58-79`); **neither preserves `location.search`** (grep for `location.search`/`preserveSearch` finds nothing). React Router resolves a string `to` to a path-only destination, dropping the active query.

**Effect:** clicking "Binding" from `/select?binding=…` lands on `/binding` with no query → `params.get("binding") ?? ""` is empty → the empty-state "Select at least two binding datasets" (`Binding.tsx:169-173`; same Perturbation/Comparison). The on-screen promise that selection is "shared with the Binding, Perturbation, and Comparison views" (`Select.tsx:489-492`) is **untrue via in-app navigation**.

**Two code paths** carry this defect: the nav bar (AC-1) and the Home feature-card links (separate, same class). **Fix:** have Nav/Home links append the current `location.search` (or introduce a tiny shared selection store), and either correct or implement the CLAUDE.md "URL + Zustand" claim.

## P2

| # | Gap | Shiny | Current |
|---|---|---|---|
| AC-2 | Workspace page headings differ in text and are **missing entirely** on the Comparison route | `workspace_heading(...)` + section `h3` per module | Binding has `<h1>`; Comparison has none (see [comparison.md](comparison.md) C-8) |
| AC-3 | Analysis sidebars don't show the "select datasets first" empty state | Sidebars render an empty-state message until enough datasets are active | Controls always rendered |
| AC-4 | Home feature-card links drop the URL query string | (shared state) | Same root cause as AC-1, separate code path (`Home.tsx`) |

## Cosmetic

| # | Gap | Evidence |
|---|---|---|
| AC-5 | No app-level "Loading data, please wait…" state; React shows a **blank page** during the blocking `/api/version` boot call (`main.tsx:22`) | `main.tsx`, `client.ts:65-73` |
| AC-6 | Nav has no version pill (see [home.md](home.md) H1) | `Nav.tsx:48-66` |
| AC-7 | Global layout = centered `container mx-auto` page-scroll vs Shiny's full-viewport fixed app shell with a 380px left context-sidebar | `Layout.tsx:5-13` vs `app.css` `.app-container`/`.context-sidebar` |
| AC-8 | GitHub badge → `-go` repo (arguably correct) | `Nav.tsx:12,65` |
| AC-9 | `perf.py` per-reactive timing logs replaced by Go structured request logs + Prometheus; no browser-side perf instrumentation (Shiny has none either) | `middleware.go:61-70` vs `perf.py:26-59` |
