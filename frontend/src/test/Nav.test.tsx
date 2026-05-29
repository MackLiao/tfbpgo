import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Nav } from "@/components/Nav";

describe("Nav", () => {
  // AC-1: the selected datasets + filters live in the URL query string. Tab
  // links must carry it forward so navigation doesn't drop the selection
  // (Shiny shares this as reactive state across all tabs).
  it("preserves the query string across tab links", () => {
    render(
      <MemoryRouter
        initialEntries={["/binding?binding=callingcards,hackett&filters=%7B%7D"]}
      >
        <Nav />
      </MemoryRouter>,
    );

    const binding = screen.getByRole("link", { name: "Binding" });
    const href = binding.getAttribute("href") ?? "";
    expect(href).toContain("binding=callingcards");
    expect(href).toContain("filters=");

    // H3: the dataset-selection tab is labelled "Dataset selection" and also
    // carries the search.
    const select = screen.getByRole("link", { name: "Dataset selection" });
    expect(select.getAttribute("href") ?? "").toContain("binding=callingcards");
  });
});
