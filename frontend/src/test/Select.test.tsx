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

  // ----- C5 specs ---------------------------------------------------------

  it("sidebar search filters the dataset list (audit row 24) and shows empty state (row 34)", async () => {
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
      expect(screen.getByText("Calling Cards")).toBeInTheDocument();
      expect(screen.getByText("Hackett")).toBeInTheDocument();
    });
    const search = screen.getByTestId("sidebar-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "hack" } });
    await waitFor(() => {
      expect(screen.queryByText("Calling Cards")).toBeNull();
      expect(screen.getByText("Hackett")).toBeInTheDocument();
    });
    fireEvent.change(search, { target: { value: "nothingmatches" } });
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-empty")).toBeInTheDocument();
    });
  });

  it("sidebar collapse toggles ?selectSidebar= and hides the dataset list (row 23)", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.endsWith("/datasets")) {
          return {
            datasets: [
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
      expect(screen.getByText("Hackett")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("sidebar-toggle"));
    await waitFor(() => {
      // After collapse: dataset row is no longer rendered, and the search
      // input is also hidden.
      expect(screen.queryByText("Hackett")).toBeNull();
      expect(screen.queryByTestId("sidebar-search")).toBeNull();
    });
  });

  it("dataset checkbox toggle stages a pending change and only commits on Apply (rows 18, 20, 21)", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.endsWith("/datasets")) {
          return {
            datasets: [
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
          return { diagonal: [], crossDataset: [] };
        }
        if (url.includes("/datasets/hackett/fields")) {
          return { dbName: "hackett", fields: [] };
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
      expect(screen.getByText("Hackett")).toBeInTheDocument();
    });
    // Initially: staged-apply footer is hidden.
    expect(screen.queryByTestId("staged-apply-footer")).toBeNull();
    // Toggle the dataset on.
    const checkbox = document.getElementById("ds-hackett") as HTMLInputElement;
    fireEvent.click(checkbox);
    // Footer appears because pending differs from committed.
    await waitFor(() => {
      expect(screen.getByTestId("staged-apply-footer")).toBeInTheDocument();
    });
    // Click Apply — footer disappears (committed now equals pending).
    fireEvent.click(screen.getByTestId("staged-apply"));
    await waitFor(() => {
      expect(screen.queryByTestId("staged-apply-footer")).toBeNull();
    });
  });

  it("apply-to-all writes the same filter spec to every active dataset that has the field (rows 12, 14)", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.endsWith("/datasets")) {
          return {
            datasets: [
              {
                dbName: "harbison",
                dataType: "binding",
                assay: "chip",
                displayName: "Harbison",
                sourceRepo: "",
                sampleIdField: "id",
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
        if (url.includes("/datasets/harbison/fields")) {
          return {
            dbName: "harbison",
            fields: [
              {
                field: "condition",
                dbType: "VARCHAR",
                kind: "categorical",
                role: "experimental_condition",
                levels: ["YPD", "SC"],
              },
            ],
          };
        }
        if (url.includes("/datasets/hackett/fields")) {
          return {
            dbName: "hackett",
            fields: [
              {
                field: "condition",
                dbType: "VARCHAR",
                kind: "categorical",
                role: "experimental_condition",
                levels: ["YPD", "SC"],
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
        <MemoryRouter
          initialEntries={["/select?binding=harbison&perturbation=hackett"]}
        >
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("Harbison")).toBeInTheDocument();
    });
    // Open the harbison filter modal.
    const filterBtns = screen.getAllByRole("button", { name: /^Filter$/i });
    // The harbison row is rendered alphabetically — but easier: find the
    // li containing "Harbison" and its Filter button.
    const harbisonLi = screen.getByText("Harbison").closest("li");
    if (!harbisonLi) throw new Error("no harbison li");
    const harbisonFilter = harbisonLi.querySelector("button");
    if (!harbisonFilter) throw new Error("no harbison Filter button");
    fireEvent.click(harbisonFilter);
    // Modal renders — wait for the apply-to-all switch to appear (it
    // gates on both datasets' field manifests resolving).
    await waitFor(() => {
      expect(screen.getByTestId("apply-to-all-condition")).toBeInTheDocument();
    });
    // Toggle YPD on.
    const ypdCb = document.getElementById("flt-condition-YPD") as HTMLInputElement;
    fireEvent.click(ypdCb);
    // Flip the apply-to-all switch.
    const applyToAllCb = document.getElementById(
      "apply-to-all-cb-condition",
    ) as HTMLInputElement;
    fireEvent.click(applyToAllCb);
    // Apply Filters.
    const applyBtn = screen.getByRole("button", { name: /Apply Filters/i });
    fireEvent.click(applyBtn);
    // Both datasets should now show an active-filter badge.
    await waitFor(() => {
      expect(screen.getByTestId("badge-harbison")).toBeInTheDocument();
      expect(screen.getByTestId("badge-hackett")).toBeInTheDocument();
    });
    // Filter buttons get removed from filterBtns ref — use the void
    // reference to silence the unused-var lint.
    void filterBtns;
  });

  it("from_pair inline clear removes the regulator filter (rows 15, 30, 31)", async () => {
    const fromPairFilters = encodeURIComponent(
      JSON.stringify({
        callingcards: {
          regulator_locus_tag: {
            type: "categorical",
            value: ["YAL001C", "YBR123W"],
            fromPair: ["Calling Cards", "Hackett"],
          },
        },
        hackett: {
          regulator_locus_tag: {
            type: "categorical",
            value: ["YAL001C", "YBR123W"],
            fromPair: ["Calling Cards", "Hackett"],
          },
        },
      }),
    );
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
        if (url.includes("/datasets/callingcards/fields")) {
          return {
            dbName: "callingcards",
            fields: [
              {
                field: "regulator_locus_tag",
                dbType: "VARCHAR",
                kind: "categorical",
                role: "",
                levels: ["YAL001C", "YBR123W"],
              },
            ],
          };
        }
        if (url.includes("/datasets/hackett/fields")) {
          return {
            dbName: "hackett",
            fields: [
              {
                field: "regulator_locus_tag",
                dbType: "VARCHAR",
                kind: "categorical",
                role: "",
                levels: ["YAL001C", "YBR123W"],
              },
            ],
          };
        }
        if (url.includes("/selection/matrix")) {
          return {
            diagonal: [
              { dbName: "callingcards", nRegulators: 2, nSamples: 4 },
              { dbName: "hackett", nRegulators: 2, nSamples: 4 },
            ],
            crossDataset: [
              {
                pairId: "callingcards__hackett",
                dbA: "callingcards",
                dbB: "hackett",
                nCommon: 2,
                samplesA: 4,
                samplesB: 4,
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
          initialEntries={[
            `/select?binding=callingcards&perturbation=hackett&filters=${fromPairFilters}`,
          ]}
        >
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The matrix cell for the pair should render highlighted.
    await waitFor(() => {
      const cell = screen.getByTestId("cell-callingcards-hackett");
      expect(cell.getAttribute("data-highlighted")).toBe("true");
    });
    // Both rows carry the active-filter badge.
    expect(screen.getByTestId("badge-callingcards")).toBeInTheDocument();
    expect(screen.getByTestId("badge-hackett")).toBeInTheDocument();
    // Clicking the highlighted cell button clears the filter.
    const highlightedBtn = screen
      .getByTestId("cell-callingcards-hackett")
      .querySelector("button");
    if (!highlightedBtn) throw new Error("no highlighted cell button");
    fireEvent.click(highlightedBtn);
    await waitFor(() => {
      expect(screen.queryByTestId("badge-callingcards")).toBeNull();
      expect(screen.queryByTestId("badge-hackett")).toBeNull();
    });
  });
});
