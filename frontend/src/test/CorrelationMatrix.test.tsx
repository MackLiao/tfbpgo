import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { CorrelationMatrix, pairKey } from "@/plots/CorrelationMatrix";
import type { Schemas } from "@/api/client";

// Unit tests for the upper-triangle correlation matrix. These assert the
// FRONTEND-derived median (the task contract: median over finite correlations),
// the upper-triangle-only interactivity (parity with
// reference/tfbpshiny/utils/correlation_matrix.py), and the pending-toggle
// callback. Median math and DOM structure are covered here; the URL/commit
// wiring is exercised end-to-end in Binding.test.tsx.

function mkPair(
  dbA: string,
  dbB: string,
  corrs: number[],
): Schemas["CorrPair"] {
  return {
    dbA,
    dbB,
    colA: `${dbA}_col`,
    colB: `${dbB}_col`,
    points: corrs.map((c, i) => ({
      dbA,
      dbAId: `${dbA}_${i}`,
      dbB,
      dbBId: `${dbB}_${i}`,
      regulatorLocusTag: `R${i}`,
      correlation: c,
    })),
  };
}

function resp(pairs: Schemas["CorrPair"][]): Schemas["CorrResponse"] {
  return {
    method: "spearman",
    col: "log10pval",
    regulatorDisplay: {},
    pairs,
  } as Schemas["CorrResponse"];
}

describe("CorrelationMatrix", () => {
  it("pairKey canonicalizes ordering", () => {
    expect(pairKey("b", "a")).toBe("a__b");
    expect(pairKey("a", "b")).toBe("a__b");
  });

  it("shows the per-pair median correlation (odd and even counts), filtering non-finite values", () => {
    render(
      <CorrelationMatrix
        resp={resp([
          mkPair("aaa", "bbb", [0.1, 0.3]), // even → mean of middle two = 0.2
          mkPair("aaa", "ccc", [0.5]), //       odd → 0.5
          // NaN should be filtered before the median; [0.4, 0.6] → 0.5.
          mkPair("bbb", "ccc", [0.4, NaN, 0.6]),
        ])}
        datasets={["aaa", "bbb", "ccc"]}
        datasetDisplay={(d) => d.toUpperCase()}
        pendingKeys={new Set()}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByTestId("corr-cell-aaa-bbb").textContent).toContain("0.200");
    expect(screen.getByTestId("corr-cell-aaa-ccc").textContent).toContain("0.500");
    expect(screen.getByTestId("corr-cell-bbb-ccc").textContent).toContain("0.500");
  });

  it("renders an em-dash for a pair with no finite correlations", () => {
    render(
      <CorrelationMatrix
        resp={resp([mkPair("aaa", "bbb", [NaN, Infinity])])}
        datasets={["aaa", "bbb"]}
        datasetDisplay={(d) => d}
        pendingKeys={new Set()}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByTestId("corr-cell-aaa-bbb").textContent).toContain("—");
  });

  it("makes upper-triangle cells interactive and lower-triangle/diagonal cells non-interactive", () => {
    render(
      <CorrelationMatrix
        resp={resp([
          mkPair("aaa", "bbb", [0.2]),
          mkPair("aaa", "ccc", [0.3]),
          mkPair("bbb", "ccc", [0.4]),
        ])}
        datasets={["aaa", "bbb", "ccc"]}
        datasetDisplay={(d) => d}
        pendingKeys={new Set()}
        onToggle={() => {}}
      />,
    );
    // Upper-triangle: button present.
    for (const id of ["corr-cell-aaa-bbb", "corr-cell-aaa-ccc", "corr-cell-bbb-ccc"]) {
      expect(screen.getByTestId(id).getAttribute("data-interactive")).toBe("true");
      expect(within(screen.getByTestId(id)).getByRole("button")).toBeInTheDocument();
    }
    // Column headers are ordered[1:] = [bbb, ccc]; aaa is only a ROW label, so
    // it is never a column id. Row bbb's first (lower-triangle/diagonal) cell is
    // therefore corr-cell-bbb-bbb — a non-interactive grey placeholder.
    expect(screen.getByTestId("corr-cell-bbb-bbb").getAttribute("data-interactive")).toBe("false");
    expect(within(screen.getByTestId("corr-cell-bbb-bbb")).queryByRole("button")).toBeNull();
  });

  it("toggles pending via onToggle with the canonical pair key, and reflects the selected style", () => {
    const onToggle = vi.fn();
    render(
      <CorrelationMatrix
        resp={resp([mkPair("aaa", "bbb", [0.2])])}
        datasets={["aaa", "bbb"]}
        datasetDisplay={(d) => d}
        pendingKeys={new Set(["aaa__bbb"])}
        onToggle={onToggle}
      />,
    );
    const cell = screen.getByTestId("corr-cell-aaa-bbb");
    expect(cell.getAttribute("data-selected")).toBe("true");
    fireEvent.click(within(cell).getByRole("button"));
    expect(onToggle).toHaveBeenCalledWith("aaa__bbb");
  });

  it("shows the 'select 2+ datasets' empty state with fewer than two datasets", () => {
    render(
      <CorrelationMatrix
        resp={resp([])}
        datasets={["aaa"]}
        datasetDisplay={(d) => d}
        pendingKeys={new Set()}
        onToggle={() => {}}
      />,
    );
    expect(screen.queryByTestId("corr-matrix")).toBeNull();
    expect(
      screen.getByText(/Select at least two binding datasets/i),
    ).toBeInTheDocument();
  });
});
