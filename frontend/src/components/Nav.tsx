import { NavLink } from "react-router-dom";

const links = [
  { to: "/", label: "Home" },
  { to: "/select", label: "Select Datasets" },
  { to: "/binding", label: "Binding" },
  { to: "/perturbation", label: "Perturbation" },
  { to: "/comparison", label: "Comparison" },
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
                isActive
                  ? "font-semibold text-blue-600"
                  : "text-slate-700 hover:text-slate-900"
              }
            >
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
