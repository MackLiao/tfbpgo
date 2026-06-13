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
      </div>
    </nav>
  );
}
