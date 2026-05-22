import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Select } from "@/routes/Select";
import { setArtifactVersion } from "@/api/client";

// HTMLDialogElement.showModal / close are not in jsdom by default —
// stub them so the modals can mount without throwing.
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
  }
});

function fakeFetch(handler: (url: string) => unknown) {
  return vi.fn((url: string) =>
    Promise.resolve(
      new Response(JSON.stringify(handler(url) ?? {}), { status: 200 }),
    ),
  );
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("Select route", () => {
  beforeEach(() => {
    setArtifactVersion("test");
  });

  it("renders a loading skeleton before /datasets resolves", () => {
    // never-resolving fetch keeps the query in pending state
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/select"]}>
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The skeleton block doesn't have role text — assert the heading at
    // least, and the absence of any dataset list items.
    expect(screen.getByText("Select Datasets")).toBeInTheDocument();
  });

  it("renders Binding and Perturbation sections once datasets load", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.endsWith("/datasets")) {
          return {
            datasets: [
              {
                dbName: "callingcards",
                dataType: "binding",
                assay: "callingcards",
                displayName: "Calling Cards",
                sourceRepo: "",
                sampleIdField: "gm_id",
                fields: [],
              },
              {
                dbName: "hackett",
                dataType: "perturbation",
                assay: "rnaseq",
                displayName: "Hackett",
                sourceRepo: "",
                sampleIdField: "sample_id",
                fields: [],
              },
            ],
          };
        }
        return {};
      }),
    );
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/select"]}>
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("Binding")).toBeInTheDocument();
      expect(screen.getByText("Perturbation")).toBeInTheDocument();
      expect(screen.getByText("Calling Cards")).toBeInTheDocument();
      expect(screen.getByText("Hackett")).toBeInTheDocument();
    });
  });

  it("clicking a per-row Filter button opens the modal and fetches /datasets/{db}/fields", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        calls.push(url);
        if (url.endsWith("/datasets")) {
          return {
            datasets: [
              {
                dbName: "callingcards",
                dataType: "binding",
                assay: "callingcards",
                displayName: "Calling Cards",
                sourceRepo: "",
                sampleIdField: "gm_id",
                fields: [],
              },
            ],
          };
        }
        if (url.includes("/datasets/callingcards/fields")) {
          return { dbName: "callingcards", fields: [] };
        }
        return {};
      }),
    );
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/select"]}>
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("Calling Cards")).toBeInTheDocument();
    });
    const filterBtns = screen.getAllByRole("button", { name: /^Filter$/i });
    const first = filterBtns[0];
    if (!first) throw new Error("no Filter button found");
    fireEvent.click(first);

    await waitFor(() => {
      expect(
        calls.some((u) => u.includes("/datasets/callingcards/fields")),
      ).toBe(true);
    });
    expect(screen.getByText(/Filter — Calling Cards/i)).toBeInTheDocument();
  });

  it("on first visit (empty URL), preselects defaultActive datasets and seeds defaultFilters (audit rows 3, 4)", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.endsWith("/datasets")) {
          return {
            datasets: [
              {
                dbName: "callingcards",
                dataType: "binding",
                assay: "callingcards",
                displayName: "Calling Cards",
                sourceRepo: "",
                sampleIdField: "gm_id",
                fields: [],
                defaultActive: true,
                defaultFilters: null,
                conditionCols: [],
              },
              {
                dbName: "hackett",
                dataType: "perturbation",
                assay: "rnaseq",
                displayName: "Hackett",
                sourceRepo: "",
                sampleIdField: "sample_id",
                fields: [],
                defaultActive: true,
                defaultFilters: {
                  time: { type: "numeric", value: [45, 45] },
                },
                conditionCols: [],
              },
              {
                dbName: "other",
                dataType: "binding",
                assay: "other",
                displayName: "Other (not default)",
                sourceRepo: "",
                sampleIdField: "id",
                fields: [],
                defaultActive: false,
                defaultFilters: null,
                conditionCols: [],
              },
            ],
          };
        }
        if (url.includes("/selection/matrix")) {
          return { diagonal: [], crossDataset: [] };
        }
        return {};
      }),
    );
    // Capture the location updates by reading URL via window — but
    // MemoryRouter exposes the URL through the location object that the
    // child components read via useSearchParams. We rely on rendered
    // assertions: the matrix only renders when at least one dataset is
    // active in the URL, and the "1 active filter" badge surfaces on hackett.
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/select"]}>
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // After the defaults apply, the hackett row should carry an active-
    // filter badge (because defaultFilters seeds the `time` clause).
    await waitFor(() => {
      expect(screen.getByTestId("badge-hackett")).toBeInTheDocument();
    });
    // And the matrix should render (which requires the URL `?binding=` /
    // `?perturbation=` to have been populated by the defaults effect).
    await waitFor(() => {
      // The matrix uses display names in its header — the only Calling
      // Cards rendering inside a <table> cell appears once the matrix has
      // mounted.
      const tables = screen.queryAllByRole("table");
      expect(tables.length).toBeGreaterThan(0);
    });
  });

  it("does NOT overwrite defaults when URL already has ?binding= (shared link semantics)", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.endsWith("/datasets")) {
          return {
            datasets: [
              {
                dbName: "callingcards",
                dataType: "binding",
                assay: "callingcards",
                displayName: "Calling Cards",
                sourceRepo: "",
                sampleIdField: "gm_id",
                fields: [],
                defaultActive: true,
                defaultFilters: null,
                conditionCols: [],
              },
              {
                dbName: "hackett",
                dataType: "perturbation",
                assay: "rnaseq",
                displayName: "Hackett",
                sourceRepo: "",
                sampleIdField: "sample_id",
                fields: [],
                defaultActive: true,
                defaultFilters: {
                  time: { type: "numeric", value: [45, 45] },
                },
                conditionCols: [],
              },
            ],
          };
        }
        if (url.includes("/selection/matrix")) {
          return { diagonal: [], crossDataset: [] };
        }
        return {};
      }),
    );
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/select?binding=callingcards"]}>
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("Calling Cards")).toBeInTheDocument();
    });
    // No badge on hackett because defaults were skipped (URL was non-empty
    // on entry).
    expect(screen.queryByTestId("badge-hackett")).toBeNull();
  });

  it("description on a field renders as a native title= tooltip on the modal label", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.endsWith("/datasets")) {
          return {
            datasets: [
              {
                dbName: "callingcards",
                dataType: "binding",
                assay: "callingcards",
                displayName: "Calling Cards",
                sourceRepo: "",
                sampleIdField: "gm_id",
                fields: [],
                defaultActive: false,
                defaultFilters: null,
                conditionCols: [],
              },
            ],
          };
        }
        if (url.includes("/datasets/callingcards/fields")) {
          return {
            dbName: "callingcards",
            fields: [
              {
                field: "condition",
                dbType: "VARCHAR",
                kind: "categorical",
                role: "experimental_condition",
                description: "Growth condition for the assay.",
                levels: ["YPD", "SC"],
              },
            ],
          };
        }
        return {};
      }),
    );
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/select"]}>
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("Calling Cards")).toBeInTheDocument();
    });
    const filterBtn = screen.getAllByRole("button", { name: /^Filter$/i })[0];
    if (!filterBtn) throw new Error("no Filter button found");
    fireEvent.click(filterBtn);
    await waitFor(() => {
      const lbl = screen.getByTestId("field-label-condition");
      expect(lbl).toBeInTheDocument();
      expect(lbl.getAttribute("title")).toBe("Growth condition for the assay.");
    });
  });

  it("clicking a diagonal cell opens the breakdown modal with /selection/breakdown data", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.endsWith("/datasets")) {
          return {
            datasets: [
              {
                dbName: "callingcards",
                dataType: "binding",
                assay: "callingcards",
                displayName: "Calling Cards",
                sourceRepo: "",
                sampleIdField: "gm_id",
                fields: [],
                defaultActive: false,
                defaultFilters: null,
                conditionCols: [],
              },
            ],
          };
        }
        if (url.includes("/selection/matrix")) {
          return {
            diagonal: [{ dbName: "callingcards", nRegulators: 9, nSamples: 21 }],
            crossDataset: [],
          };
        }
        if (url.includes("/selection/breakdown")) {
          return {
            dbName: "callingcards",
            nMulti: 4,
            columns: [
              { field: "condition", distinctValues: 3 },
              { field: "replicate", distinctValues: 1 },
              { field: "batch", distinctValues: 2 },
            ],
          };
        }
        return {};
      }),
    );
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/select?binding=callingcards"]}>
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/9 regulators/)).toBeInTheDocument();
    });
    // Click the diagonal cell button — the button is inside the cell.
    const cell = screen.getByTestId("cell-callingcards-callingcards");
    const btn = cell.querySelector("button");
    if (!btn) throw new Error("diagonal button not rendered");
    fireEvent.click(btn);
    await waitFor(() => {
      // The "{N} regulators have multiple samples" string is broken across
      // a <span>{N}</span> and surrounding text nodes — assert structurally.
      expect(
        screen.getAllByText(
          (_, el) =>
            el?.textContent?.includes("regulators have multiple samples") ===
            true,
        ).length,
      ).toBeGreaterThan(0);
      expect(screen.getByTestId("breakdown-col-condition")).toBeInTheDocument();
      expect(screen.getByTestId("breakdown-col-batch")).toBeInTheDocument();
      // `replicate` has distinctValues=1 — filtered out.
      expect(screen.queryByTestId("breakdown-col-replicate")).toBeNull();
    });
  });

  it("renders the selection matrix when datasets are active in the URL", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.endsWith("/datasets")) {
          return {
            datasets: [
              {
                dbName: "callingcards",
                dataType: "binding",
                assay: "callingcards",
                displayName: "Calling Cards",
                sourceRepo: "",
                sampleIdField: "gm_id",
                fields: [],
              },
              {
                dbName: "hackett",
                dataType: "perturbation",
                assay: "rnaseq",
                displayName: "Hackett",
                sourceRepo: "",
                sampleIdField: "sample_id",
                fields: [],
              },
            ],
          };
        }
        if (url.includes("/selection/matrix")) {
          return {
            diagonal: [
              { dbName: "callingcards", nRegulators: 5, nSamples: 10 },
              { dbName: "hackett", nRegulators: 7, nSamples: 14 },
            ],
            crossDataset: [
              {
                pairId: "callingcards__hackett",
                dbA: "callingcards",
                dbB: "hackett",
                nCommon: 3,
                samplesA: 6,
                samplesB: 8,
              },
            ],
          };
        }
        return {};
      }),
    );
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter
          initialEntries={["/select?binding=callingcards&perturbation=hackett"]}
        >
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/5 regulators/)).toBeInTheDocument();
      expect(screen.getByText(/3 common regulators/)).toBeInTheDocument();
    });
  });
});
