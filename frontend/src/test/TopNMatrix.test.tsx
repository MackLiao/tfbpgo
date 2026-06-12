import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { TopNMatrix } from "@/plots/TopNMatrix";
import type { Schemas } from "@/api/client";

// Unit tests for the binding × perturbation responsive-ratio matrix
// (Compare Datasets tab). These assert the FRONTEND-derived cell median (the
// task contract: median-of-per-regulator-medians of responsiveRatio*100,
// formatted as an integer percent — parity with
// reference/tfbpshiny/modules/comparison/server/workspace.py:1228-1235), the
// "—" placeholder for absent pairs, and the row/column click → selection
// callbacks. The matrix↔distribution wiring is exercised end-to-end in
// Comparison.test.tsx.

function mkRow(
  bindingDB: string,
  perturbationDB: string,
  regulatorLocusTag: string,
  responsiveRatio: number,
): Schemas["TopNRow"] {
  return {
    pairKey: `${bindingDB}__${perturbationDB}`,
    bindingSampleId: `${bindingDB}_s`,
    regulatorLocusTag,
    regulatorDisplayName: regulatorLocusTag,
    perturbationSampleId: `${perturbationDB}_s`,
    n: 25,
    nResponsive: Math.round(responsiveRatio * 25),
    responsiveRatio,
  };
}

function resp(rows: Schemas["TopNRow"][]): Schemas["TopNResponse"] {
  return { topN: 25, effectThreshold: 0, pvalueThreshold: 0.05, rows };
}

const noop = () => {};

describe("TopNMatrix", () => {
  it("renders cell medians as integer percents (median of per-regulator medians)", () => {
    // Pair (b1, p1): two regulators.
    //   R1 rows → responsiveRatio [0.2, 0.4] → per-reg median 0.3 → 30%
    //   R2 rows → responsiveRatio [0.6]      → per-reg median 0.6 → 60%
    //   median of [30, 60] = 45 → "45%"
    render(
      <TopNMatrix
        resp={resp([
          mkRow("b1", "p1", "R1", 0.2),
          mkRow("b1", "p1", "R1", 0.4),
          mkRow("b1", "p1", "R2", 0.6),
        ])}
        bindingDatasets={["b1"]}
        perturbationDatasets={["p1"]}
        displayName={(d) => d.toUpperCase()}
        selection={{ binding: null, perturbation: null }}
        onSelectBinding={noop}
        onSelectPerturbation={noop}
      />,
    );
    expect(screen.getByTestId("topn-cell-b1-p1").textContent).toContain("45%");
  });

  it("renders an em-dash for a pair with no rows", () => {
    render(
      <TopNMatrix
        resp={resp([mkRow("b1", "p1", "R1", 0.5)])}
        bindingDatasets={["b1"]}
        perturbationDatasets={["p1", "p2"]}
        displayName={(d) => d}
        selection={{ binding: null, perturbation: null }}
        onSelectBinding={noop}
        onSelectPerturbation={noop}
      />,
    );
    // p1 has data; p2 has no rows for b1 → placeholder.
    expect(screen.getByTestId("topn-cell-b1-p1").textContent).toContain("50%");
    expect(screen.getByTestId("topn-cell-b1-p2").textContent).toContain("—");
  });

  it("uses displayName for row/column headers", () => {
    render(
      <TopNMatrix
        resp={resp([mkRow("callingcards", "hackett", "R1", 0.5)])}
        bindingDatasets={["callingcards"]}
        perturbationDatasets={["hackett"]}
        displayName={(d) => (d === "callingcards" ? "Calling Cards" : "Hackett")}
        selection={{ binding: null, perturbation: null }}
        onSelectBinding={noop}
        onSelectPerturbation={noop}
      />,
    );
    expect(
      within(screen.getByTestId("topn-row-callingcards")).getByText("Calling Cards"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("topn-col-hackett")).getByText("Hackett"),
    ).toBeInTheDocument();
  });

  it("clicking a row header selects that binding", () => {
    const onSelectBinding = vi.fn();
    render(
      <TopNMatrix
        resp={resp([mkRow("b1", "p1", "R1", 0.5)])}
        bindingDatasets={["b1"]}
        perturbationDatasets={["p1"]}
        displayName={(d) => d}
        selection={{ binding: null, perturbation: null }}
        onSelectBinding={onSelectBinding}
        onSelectPerturbation={noop}
      />,
    );
    fireEvent.click(within(screen.getByTestId("topn-row-b1")).getByRole("button"));
    expect(onSelectBinding).toHaveBeenCalledWith("b1");
  });

  it("clicking a column header selects that perturbation", () => {
    const onSelectPerturbation = vi.fn();
    render(
      <TopNMatrix
        resp={resp([mkRow("b1", "p1", "R1", 0.5)])}
        bindingDatasets={["b1"]}
        perturbationDatasets={["p1"]}
        displayName={(d) => d}
        selection={{ binding: null, perturbation: null }}
        onSelectBinding={noop}
        onSelectPerturbation={onSelectPerturbation}
      />,
    );
    fireEvent.click(within(screen.getByTestId("topn-col-p1")).getByRole("button"));
    expect(onSelectPerturbation).toHaveBeenCalledWith("p1");
  });

  it("clicking an interior cell drills into the binding row (selects binding)", () => {
    const onSelectBinding = vi.fn();
    const onSelectPerturbation = vi.fn();
    render(
      <TopNMatrix
        resp={resp([mkRow("b1", "p1", "R1", 0.5)])}
        bindingDatasets={["b1"]}
        perturbationDatasets={["p1"]}
        displayName={(d) => d}
        selection={{ binding: null, perturbation: null }}
        onSelectBinding={onSelectBinding}
        onSelectPerturbation={onSelectPerturbation}
      />,
    );
    fireEvent.click(within(screen.getByTestId("topn-cell-b1-p1")).getByRole("button"));
    // Reference _on_cell sets binding=b, perturbation=None.
    expect(onSelectBinding).toHaveBeenCalledWith("b1");
    expect(onSelectPerturbation).not.toHaveBeenCalled();
  });

  it("marks the selected row's cells active (row OR column selected)", () => {
    render(
      <TopNMatrix
        resp={resp([
          mkRow("b1", "p1", "R1", 0.5),
          mkRow("b2", "p1", "R1", 0.5),
        ])}
        bindingDatasets={["b1", "b2"]}
        perturbationDatasets={["p1", "p2"]}
        displayName={(d) => d}
        selection={{ binding: "b1", perturbation: null }}
        onSelectBinding={noop}
        onSelectPerturbation={noop}
      />,
    );
    // Whole b1 row active; b2 row inactive.
    expect(screen.getByTestId("topn-cell-b1-p1").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("topn-cell-b1-p2").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("topn-cell-b2-p1").getAttribute("data-selected")).toBeNull();
  });

  it("gives interior cells an aria-label + aria-pressed for header-parity a11y", () => {
    render(
      <TopNMatrix
        resp={resp([mkRow("callingcards", "hackett", "R1", 0.4)])}
        bindingDatasets={["callingcards"]}
        perturbationDatasets={["hackett"]}
        displayName={(d) => (d === "callingcards" ? "Calling Cards" : "Hackett")}
        selection={{ binding: "callingcards", perturbation: null }}
        onSelectBinding={noop}
        onSelectPerturbation={noop}
      />,
    );
    const btn = within(
      screen.getByTestId("topn-cell-callingcards-hackett"),
    ).getByRole("button");
    expect(btn.getAttribute("aria-label")).toBe("Calling Cards × Hackett: 40%");
    // Row is selected → cell is active → aria-pressed reflects it.
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the empty state when a dataset axis is empty", () => {
    render(
      <TopNMatrix
        resp={resp([])}
        bindingDatasets={[]}
        perturbationDatasets={["p1"]}
        displayName={(d) => d}
        selection={{ binding: null, perturbation: null }}
        onSelectBinding={noop}
        onSelectPerturbation={noop}
      />,
    );
    expect(screen.queryByTestId("topn-matrix")).toBeNull();
    expect(
      screen.getByText(/Select at least one binding and one perturbation/i),
    ).toBeInTheDocument();
  });
});
