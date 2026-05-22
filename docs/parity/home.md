# Home Module — Parity Inventory

**Generated:** 2026-05-21
**Shiny source:** `reference/tfbpshiny/modules/home/`
**React target:** `frontend/src/routes/Home.tsx`
**Backend touchpoints:** none (Home renders static content; `/api/version` is called on app boot from `frontend/src/main.tsx:22`, not from the Home route itself)

## 1. Summary

The Home page is the simplest module in the app: a static splash with a warning banner, intro copy, and four navigation entry points. The React version reproduces the text content and intro structure well, but downgrades the four Bootstrap **feature cards with embedded images** into a plain `<ul>` list. The visual identity of the Shiny app (wine-red pill nav, GitHub badge with version, "Welcome" workspace shell) is also absent in the React shell that surrounds Home. No backend changes are required; this is a pure frontend/UI parity gap.

## 2. Feature matrix

| # | Feature (what user sees/does) | Shiny behavior (file:line) | React status | Gap | Severity |
|---|------------------------------|-----------------------------|---------------|------|----------|
| 1 | "Under development" amber warning banner | `reference/tfbpshiny/modules/home/ui.py:68-72` (`alert alert-warning`, bold "Under development:" prefix) | DONE | Visual styling differs (Tailwind amber vs Bootstrap) but content + role are equivalent (`frontend/src/routes/Home.tsx:6-11`) | P2 |
| 2 | Page title "Welcome to the TF Binding and Perturbation Explorer" | `ui.py:73` (`ui.h2`) | DONE | Renders as `<h1>` instead of `<h2>` (`Home.tsx:13`); minor semantic drift, fine for a route landing page | P2 |
| 3 | Intro paragraph with italicized *Saccharomyces cerevisiae* | `ui.py:74-81` | DONE | `Home.tsx:14-19` | — |
| 4 | "Getting Started" subheading | `ui.py:82` (`ui.h3`) | DONE | Renders as `<h2>` (`Home.tsx:21`); fine | P2 |
| 5 | Lead-in sentence describing the cards/links | `ui.py:83-85` "The tabs above take you to pages for selecting and comparing datasets." | PARTIAL | React rephrases to "The links below…" (`Home.tsx:22`). Shiny uses **tabs above** because the cards are decorative duplicates of the nav; React removed the cards so the rephrase is correct, but it confirms the cards were dropped. | P2 |
| 6 | "Dataset selection" feature card (no image) | `ui.py:88-94` via `_feature_card()` → Bootstrap `.card.mb-3` > `.card-body` containing bold nav link + description | DONE | Closed in Phase C — commit `b887de0`. Bootstrap-style `Card` chrome with bold wine-red link title + description. | — |
| 7 | "Binding" feature card **with `binding.png` image** | `ui.py:95-100` via `_feature_card(..., image="binding.png")` → image is 100x100 contain-fit, flex row with gap-4, served from Shiny `www/binding.png` (`reference/tfbpshiny/www/binding.png` confirmed present) | DONE | Closed in Phase C — commit `b887de0`. `frontend/public/binding.png` copied from reference; rendered 100x100 contain-fit inside the feature card. | — |
| 8 | "Perturbation" feature card **with `perturbation.png` image** | `ui.py:101-107` (`image="perturbation.png"`); `reference/tfbpshiny/www/perturbation.png` present | DONE | Closed in Phase C — commit `b887de0`. `frontend/public/perturbation.png` copied; rendered identically to the binding card. | — |
| 9 | "Comparison" feature card (no image) | `ui.py:108-113` | DONE | Closed in Phase C — commit `b887de0`. Same Bootstrap-style card chrome as #6. | — |
| 10 | Card title is a **bold link** that navigates | `ui.py:14-19` `_nav_link` builds `<a href="#" onclick="click nav button">` styled `font-weight: bold; color: var(--color-nav)` (#722F37 wine) | PARTIAL | React uses `<Link to="/select">` with `<strong>` (semantically correct, no JS click-injection hack), but the wine `--color-nav` color is **not** applied — React uses default link blue/slate. (`Home.tsx:26,33,40,47`) | P2 |
| 11 | Click on card title navigates to the page | Shiny clicks the corresponding `nav_button` (`document.getElementById('selection').click()`) which fires `input.selection` → `active_module.set("selection")` (`reference/tfbpshiny/app.py:245-254`) | DONE | React uses real router `<Link to="/select">` — better than the Shiny click hack. URL changes too (Shiny did not change URL). | — |
| 12 | Outer container padding `p-4` (16 px all sides) | `ui.py:67` | PARTIAL | React relies on `Layout.tsx:9` (`p-4` on `<main>`) — equivalent total padding, but Home itself has no inner padding wrapper. Effect is similar; acceptable. | P2 |
| 13 | Top nav bar with HOME / Dataset selection / Binding / Perturbation / Comparison pill buttons | Built outside the home module in `reference/tfbpshiny/app.py:79-93` via `nav_button` (wine-red `.nav-btn` pills, `--color-nav` #722F37, active state `--color-nav-active`) | DONE | Closed in Phase C — commit `b887de0`. `Nav.tsx` uses NavLink with wine-red pill chrome (`bg-wine #722F37` active, `bg-slate-100` hover, `rounded-md px-4 py-2`); `tailwind.config.ts` exposes the `wine` palette. | — |
| 14 | GitHub badge with version pill on the right of nav bar | `reference/tfbpshiny/app.py:92` + `components.py:296-321` (`github_badge()`, SVG octocat + `BrentLab/tfbpshiny` + `v{version}` pill) | DONE | Closed in Phase C — commit `b887de0`. `Nav.tsx` adds an octocat SVG + repo label badge on the right (hidden below the `sm` breakpoint). | — |
| 15 | "TF / Binding & Perturbation / Explorer" three-line nav logo block | `app.py:83` (`.nav-logo`) | DONE | Closed in Phase C — commit `b887de0`. `Nav.tsx` renders the three-line "TF / Binding & Perturbation / Explorer" logo on the left. | — |
| 16 | Loading state while VirtualDB initializes (Home is the one page that **stays interactive** before init completes) | `app.py:300-326` — Home renders immediately even while `_init_result() is None`; other modules show "Loading data, please wait…" | DONE | React doesn't have a init-blocking screen at all (the Go backend opens DuckDB read-only at startup, so there's nothing to wait for — see spec §9.5). Home stays interactive. Equivalent. | — |
| 17 | URL deep-linking to Home | Shiny: no URL change — `active_module` is reactive in-memory state only; refreshing the page always lands on `"home"` (`app.py:108`). No deep link. | DONE+ | React: `path="/"` in `App.tsx:13`; refresh on `/` lands on Home. **Strict improvement** — also supports `/select`, `/binding`, `/perturbation`, `/comparison`. | — |
| 18 | Error boundary around content | Shiny: implicit Shiny-level error handling | DONE | `Layout.tsx:10` wraps children in `ErrorBoundary` | — |

## 3. Controls (inputs, selectors, toggles)

The Home module has **no controls** in either implementation. It is a static splash page. The only interactive elements are the four card title links (Shiny) / list links (React).

- Shiny: `_nav_link()` → 4 anchor elements that click the nav buttons (`ui.py:14-19`, used at `ui.py:88, 95, 102, 109`)
- React: 4 `<Link>` from `react-router-dom` (`Home.tsx:26, 33, 40, 47`)

Status: **DONE** (navigation works; URL routing is an improvement over Shiny's stateful nav).

## 4. Outputs (plots, tables, text panels, downloads)

No plots, tables, or downloads. Outputs are pure text + layout chrome:

- Warning alert (`ui.py:68-72` → `Home.tsx:6-11`) — DONE
- `<h2>` "Welcome…" (`ui.py:73` → `Home.tsx:13`) — DONE
- Intro `<p>` with italics (`ui.py:74-81` → `Home.tsx:14-19`) — DONE
- `<h3>` "Getting Started" (`ui.py:82` → `Home.tsx:21`) — DONE
- 4 Bootstrap feature cards in `mt-3` container (`ui.py:86-114`) — **PARTIAL** (rendered as `<ul>` bullets, see matrix #6-9)
- Two PNG illustrations inside Binding + Perturbation cards (`ui.py:99, 106`) — **MISSING** (assets not in frontend tree)

## 5. Data flow

- **Shiny queries:** None. `home_ui()` is purely declarative (`ui.py:65-115`) and `page_test.py:24-25` confirms `server()` is a no-op for Home.
- **React API calls:** None from `Home.tsx`. `/api/version` is called once at app boot from `frontend/src/main.tsx:22` (`refreshArtifactVersion()` in `frontend/src/api/client.ts:65-69`), independent of route. Home itself does no fetching.
- **Mismatches:** None. Home is data-free in both implementations. No backend gap.

## 6. URL state / deep linking

- **Shiny:** No URL state. `active_module` is in-memory reactive (`app.py:108`), default `"home"`. Refresh always lands on Home. No deep link to any other page.
- **React:** Full URL routing via `react-router-dom`. `/` → Home, `/select` → Select Datasets, etc. (`App.tsx:13-17`). Refresh preserves the active page. **Strict improvement** over Shiny.
- **Home-specific URL params:** Neither side defines any (`?foo=bar` query params, hash fragments, etc.). None expected for a splash page.

## 7. Backend gaps blocking parity

**None.** The Home page does not consume any backend endpoint. Closing this parity gap requires only frontend work (asset placement + JSX/CSS).

For completeness, endpoints currently registered in the backend that any page may rely on (`backend/internal/api/router.go` referenced by handlers):
- `/healthz`, `/readyz`, `/metrics`, `/api/version` (`backend/internal/api/version.go:10-24`, `health.go`)
- `/api/v/{v}/datasets`, `/regulators`, `/regulators/resolve`, `/binding`, `/perturbation`, `/comparison/topn`, `/comparison/dto`

Home uses none of these directly.

## 8. Open questions

1. **Should the React Home page preserve the Bootstrap card visual treatment, or has the design intentionally moved to a flat list?** The card layout is a noticeable UX downgrade if unintentional. Decision needed before implementing #6-#9.
2. **Where should the `binding.png` / `perturbation.png` assets live?** Options:
   - `frontend/public/binding.png` (copied verbatim from `reference/tfbpshiny/www/binding.png`) — served from `/binding.png`.
   - `frontend/src/assets/binding.png` (imported, hashed by Vite) — preferred for cache busting.
   The Go binary serves the embedded SPA via `embed.FS` (per `CLAUDE.md`), so whichever Vite emits to `dist/` will ship.
3. **Is the wine-red nav palette (`--color-nav: #722F37`) and pill-shaped nav an intentional drop, or pending design port?** This affects Home indirectly via the surrounding `Nav.tsx` (matrix #13). It also affects the card-title link color (#10). If the palette is being kept, the Home cards should match.
4. **GitHub badge with version (#14) and three-line logo (#15)** — drop intentionally or port? They were visible on Home in Shiny.
5. **`<h2>` vs `<h1>` for the welcome title (#2):** confirm that `<h1>` is the chosen semantic level for route-level pages going forward (affects consistency with other routes; not a blocker).
6. **Card title text color** — Shiny used `var(--color-nav)` (#722F37). If wine palette is being kept, define a Tailwind color or CSS variable in `frontend/src/styles/globals.css` and use it on the four `<Link>` elements.

---

_Audit table updated 2026-05-22 after Phase C completion._
