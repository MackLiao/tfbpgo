# Home + global nav/layout chrome

**Parity verdict:** Content is a faithful port; the global *chrome* (nav, logo, layout shell, version pill) diverges cosmetically. No P0/P1 here — but one P1 that surfaces *through* the Home page (feature-card links dropping the query string) is shared with the nav and lives in [app-chrome.md](app-chrome.md).

The warning alert, intro paragraph, "Getting Started" section, and all four feature cards (titles, descriptions, image placement) match Shiny closely. The two card images are **byte-identical** copies (sha256 match between `frontend/public/` and `reference/tfbpshiny/www/`) — see [non-gaps.md](non-gaps.md). The wine-red nav palette is correctly mirrored into `tailwind.config.ts`.

## Cosmetic divergences (all confirmed against HEAD)

| # | Gap | Shiny | Current |
|---|---|---|---|
| H1 | **Version pill missing** from nav GitHub badge | `github_badge()` renders `<span class="github-badge-version">v{_version}</span>` (`components.py:316-320`, styled `app.css:492-500`) | No version element at all (`Nav.tsx:48-66`); `/api/version` is fetched (`main.tsx:22`) but used only for cache-key gating, never rendered. *Note: the rewrite's `artifactVersion` ≠ Shiny's package version, so even a naive port wouldn't byte-match — this is out-of-band chrome.* |
| H2 | GitHub badge repo/label | `https://github.com/BrentLab/tfbpshiny` / "BrentLab/tfbpshiny" (`components.py:68,316-319`) | `…/tfbpshiny-go` / "BrentLab/tfbpshiny-go" (`Nav.tsx:12,65`). Arguably correct for the rewrite, but a deliberate divergence. |
| H3 | Nav label text | "Dataset selection" (`app.py:87`) | "Select Datasets" (`Nav.tsx:6`). The Home *card* title is correctly "Dataset selection" (`Home.tsx:59`), so nav and card disagree with each other. |
| H4 | Heading levels shifted | `h2` welcome / `h3` Getting Started (`home/ui.py:73,82`) | `h1` / `h2` (`Home.tsx:46,54`). Shiny reserves the `h1`/20px slot for the per-page workspace title. |
| H5 | Nav logo rendering | One `nav-logo` div with literal `"TF\nBinding & Perturbation\nExplorer"`; `.nav-logo` has **no CSS** so the `\n` collapse to single-line default-color text (`app.py:83`) | Three stacked `<div>`s, `text-xs font-bold text-wine`, hidden below `sm` (`Nav.tsx:19-26`) → three small wine lines. |
| H6 | Nav active styling **inverted** | All nav buttons render as identical wine pills, **no** active highlight (`app.py` nav buttons) | Only the *active* link is a wine pill; inactive links are plain gray text (`Nav.tsx`). |
| H7 | Layout model | Full-viewport flex app shell: `.app-container` `height:100vh; overflow:hidden`, fixed 52px nav, `.app-body` flex row, 380px context-sidebar flush-left | Centered `container mx-auto` max-width, page-scrolling (`Layout.tsx:5-13`, `Nav.tsx:17`). See [app-chrome.md](app-chrome.md). |
| H8 | Browser tab title | Shiny default (no custom title) | Hard-coded `<title>tfbpshiny-go</title>` (`index.html:6`) — the repo slug, not the branding string. |
| H9 | Image-less cards layout | Plain block `card-body` for Dataset-selection & Comparison cards | flex-row layout (`Home.tsx`) — harmless. |
| H10 | Feature-card image alt text differs; "Under development" banner uses Tailwind amber vs Bootstrap `alert-warning` | — | Cosmetic. |

**Recommendation:** H1 (version pill) is the only one with informational value; the rest are pure visual polish. None block cutover. If chrome fidelity matters, H6 (inverted active styling) is the most visible behavioral difference.
