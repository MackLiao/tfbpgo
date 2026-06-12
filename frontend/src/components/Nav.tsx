import { NavLink, useLocation } from "react-router-dom";
import { cn } from "@/lib/cn";

const links = [
  { to: "/", label: "Home", end: true },
  // H3: label matches Shiny's nav ("Dataset selection", app.py:87) and the
  // Home feature card, which previously disagreed ("Select Datasets").
  { to: "/select", label: "Dataset selection", end: false },
  { to: "/binding", label: "Binding", end: false },
  { to: "/perturbation", label: "Perturbation", end: false },
  { to: "/comparison", label: "Binding/Perturbation Comparisons", end: false },
];

const GITHUB_URL = "https://github.com/BrentLab/tfbpshiny-go";

export function Nav() {
  // AC-1: carry the current query string (?binding=/?perturbation=/?filters=,
  // plus per-view params) across tab navigation so the selected datasets +
  // filters survive — Shiny shares this as reactive state across all tabs.
  const location = useLocation();
  return (
    <nav className="border-b bg-white">
      <div className="container mx-auto flex items-center justify-between gap-4 p-3">
        <div className="flex items-center gap-4">
          <div
            className="hidden text-xs font-bold leading-tight text-wine sm:block"
            aria-label="TF Binding & Perturbation Explorer"
          >
            <div>TF</div>
            <div>Binding &amp; Perturbation</div>
            <div>Explorer</div>
          </div>
          <ul className="flex gap-2">
            {links.map(({ to, label, end }) => (
              <li key={to}>
                <NavLink
                  to={{ pathname: to, search: location.search }}
                  end={end}
                  className={({ isActive }) =>
                    cn(
                      "rounded-md px-4 py-2 font-medium transition-colors",
                      isActive
                        ? "bg-wine text-white hover:bg-wine-active"
                        : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                    )
                  }
                >
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="hidden items-center gap-1.5 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 sm:inline-flex"
          aria-label="GitHub repository"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          <span>BrentLab/tfbpshiny-go</span>
        </a>
      </div>
    </nav>
  );
}
