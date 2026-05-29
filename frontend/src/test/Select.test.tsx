import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { Select } from "@/routes/Select";
import { setArtifactVersion } from "@/api/client";

/** Surfaces the live URL search string so tests can assert ?filters= writes. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc-search">{loc.search}</div>;
}

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

// Shared fixtures for the apply-to-all / regulator / reset / activate specs.
const TWO_DATASETS = [
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
];
const CONDITION_FIELD = {
  field: "condition",
  dbType: "VARCHAR",
  kind: "categorical",
  role: "experimental_condition",
  levels: ["YPD", "SC"],
};
const REGS = [
  { locusTag: "YPL248C", symbol: "GAL4", display: "GAL4 (YPL248C)" },
  { locusTag: "YLR451W", symbol: "LEU3", display: "LEU3 (YLR451W)" },
];

/** Handler for two datasets that both expose a common `condition` field. */
function conditionHandler(url: string): unknown {
  if (url.endsWith("/datasets")) return { datasets: TWO_DATASETS };
  if (url.includes("/datasets/harbison/fields"))
    return { dbName: "harbison", fields: [CONDITION_FIELD] };
  if (url.includes("/datasets/hackett/fields"))
    return { dbName: "hackett", fields: [CONDITION_FIELD] };
  if (url.includes("/datasets/harbison/regulators"))
    return { dbName: "harbison", regulators: REGS };
  if (url.includes("/datasets/hackett/regulators"))
    return { dbName: "hackett", regulators: REGS };
  if (url.includes("/selection/matrix")) return { diagonal: [], crossDataset: [] };
  return {};
}

function openFilterModalFor(displayName: string): void {
  // The display name can appear in both the sidebar list AND the rendered
  // matrix headers; target the sidebar <li> that carries a Filter button.
  for (const el of screen.getAllByText(displayName)) {
    const li = el.closest("li");
    const btn = li?.querySelector("button");
    if (btn) {
      fireEvent.click(btn);
      return;
    }
  }
  throw new Error(`no ${displayName} sidebar row with a Filter button`);
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
                dbName: "harbison",
                dataType: "binding",
                assay: "ChIP-chip",
                displayName: "Harbison 2004",
                sourceRepo: "",
                sampleIdField: "sample_id",
                fields: ["condition"],
                defaultActive: false,
                defaultFilters: null,
                conditionCols: ["condition"],
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
      expect(screen.getByText("Harbison 2004")).toBeInTheDocument();
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
                dbName: "harbison",
                dataType: "binding",
                assay: "ChIP-chip",
                displayName: "Harbison 2004",
                sourceRepo: "",
                sampleIdField: "sample_id",
                fields: ["condition"],
                defaultActive: false,
                defaultFilters: null,
                conditionCols: ["condition"],
              },
            ],
          };
        }
        if (url.includes("/selection/matrix")) {
          return {
            diagonal: [{ dbName: "harbison", nRegulators: 9, nSamples: 21 }],
            crossDataset: [],
          };
        }
        if (url.includes("/selection/breakdown")) {
          return {
            dbName: "harbison",
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
        <MemoryRouter initialEntries={["/select?binding=harbison"]}>
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/9 regulators/)).toBeInTheDocument();
    });
    // Click the diagonal cell button — the button is inside the cell.
    const cell = screen.getByTestId("cell-harbison-harbison");
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

  it("experimental_condition apply-to-all defaults ON and mirrors the filter to every active dataset (rows 12, 14; SD-10)", async () => {
    vi.stubGlobal("fetch", fakeFetch(conditionHandler));
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
    openFilterModalFor("Harbison");
    // The apply-to-all switch gates on both datasets' field manifests resolving.
    await waitFor(() => {
      expect(screen.getByTestId("apply-to-all-condition")).toBeInTheDocument();
    });
    // SD-10: experimental_condition defaults the toggle to ON.
    const applyToAllCb = document.getElementById(
      "apply-to-all-cb-condition",
    ) as HTMLInputElement;
    expect(applyToAllCb.checked).toBe(true);
    // Select YPD and Apply WITHOUT touching the toggle.
    fireEvent.click(document.getElementById("flt-condition-YPD") as HTMLInputElement);
    fireEvent.click(screen.getByRole("button", { name: /Apply Filters/i }));
    // Default-ON propagates to every active dataset.
    await waitFor(() => {
      expect(screen.getByTestId("badge-harbison")).toBeInTheDocument();
      expect(screen.getByTestId("badge-hackett")).toBeInTheDocument();
    });
  });

  it("flipping apply-to-all OFF writes the filter only to the opened dataset", async () => {
    vi.stubGlobal("fetch", fakeFetch(conditionHandler));
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter
          initialEntries={["/select?binding=harbison&perturbation=hackett"]}
        >
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("Harbison")).toBeInTheDocument());
    openFilterModalFor("Harbison");
    await waitFor(() =>
      expect(screen.getByTestId("apply-to-all-condition")).toBeInTheDocument(),
    );
    // Flip apply-to-all OFF (default was ON), then select YPD and Apply.
    fireEvent.click(document.getElementById("apply-to-all-cb-condition") as HTMLInputElement);
    fireEvent.click(document.getElementById("flt-condition-YPD") as HTMLInputElement);
    fireEvent.click(screen.getByRole("button", { name: /Apply Filters/i }));
    await waitFor(() => expect(screen.getByTestId("badge-harbison")).toBeInTheDocument());
    expect(screen.queryByTestId("badge-hackett")).toBeNull();
  });

  it("the Regulator card applies a regulator_locus_tag filter to all active datasets (SD-5)", async () => {
    vi.stubGlobal("fetch", fakeFetch(conditionHandler));
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter
          initialEntries={["/select?binding=harbison&perturbation=hackett"]}
        >
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("Harbison")).toBeInTheDocument());
    openFilterModalFor("Harbison");
    // The regulator card loads its per-dataset choices.
    await waitFor(() =>
      expect(screen.getByTestId("regulator-option-YPL248C")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("regulator-option-YPL248C"));
    // Regulator apply-to-all defaults ON, so Apply mirrors to every dataset.
    fireEvent.click(screen.getByRole("button", { name: /Apply Filters/i }));
    await waitFor(() => {
      expect(screen.getByTestId("badge-harbison")).toBeInTheDocument();
      expect(screen.getByTestId("badge-hackett")).toBeInTheDocument();
    });
  });

  it("removing a previously apply-to-all field clears it from sibling datasets (SD-6c)", async () => {
    const preset = encodeURIComponent(
      JSON.stringify({
        harbison: { condition: { type: "categorical", value: ["YPD"], applyToAll: true } },
        hackett: { condition: { type: "categorical", value: ["YPD"], applyToAll: true } },
      }),
    );
    vi.stubGlobal("fetch", fakeFetch(conditionHandler));
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter
          initialEntries={[
            `/select?binding=harbison&perturbation=hackett&filters=${preset}`,
          ]}
        >
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Both datasets start with the shared condition filter.
    await waitFor(() => {
      expect(screen.getByTestId("badge-harbison")).toBeInTheDocument();
      expect(screen.getByTestId("badge-hackett")).toBeInTheDocument();
    });
    openFilterModalFor("Harbison");
    // The YPD checkbox reflects the persisted selection.
    await waitFor(() => {
      const ypd = document.getElementById("flt-condition-YPD") as HTMLInputElement;
      expect(ypd.checked).toBe(true);
    });
    // Deselect YPD → condition removed from pending → Apply triggers the
    // retroactive clear of the shared field from hackett too.
    fireEvent.click(document.getElementById("flt-condition-YPD") as HTMLInputElement);
    fireEvent.click(screen.getByRole("button", { name: /Apply Filters/i }));
    await waitFor(() => {
      expect(screen.queryByTestId("badge-harbison")).toBeNull();
      expect(screen.queryByTestId("badge-hackett")).toBeNull();
    });
  });

  it("Reset clears common-field filters from every dataset and closes (SD-6b)", async () => {
    const preset = encodeURIComponent(
      JSON.stringify({
        harbison: { condition: { type: "categorical", value: ["YPD"], applyToAll: true } },
        hackett: { condition: { type: "categorical", value: ["YPD"], applyToAll: true } },
      }),
    );
    vi.stubGlobal("fetch", fakeFetch(conditionHandler));
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter
          initialEntries={[
            `/select?binding=harbison&perturbation=hackett&filters=${preset}`,
          ]}
        >
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("badge-harbison")).toBeInTheDocument();
      expect(screen.getByTestId("badge-hackett")).toBeInTheDocument();
    });
    openFilterModalFor("Harbison");
    await waitFor(() =>
      expect(screen.getByText(/Filter — Harbison/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Reset$/i }));
    // Reset clears the common `condition` filter from BOTH datasets and closes.
    await waitFor(() => {
      expect(screen.queryByTestId("badge-harbison")).toBeNull();
      expect(screen.queryByTestId("badge-hackett")).toBeNull();
      expect(screen.queryByText(/Filter — Harbison/i)).toBeNull();
    });
  });

  it("filtering an inactive dataset activates it (SD-9)", async () => {
    vi.stubGlobal("fetch", fakeFetch(conditionHandler));
    render(
      <QueryClientProvider client={makeClient()}>
        {/* Only harbison active; hackett is off. */}
        <MemoryRouter initialEntries={["/select?binding=harbison"]}>
          <Select />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("Hackett")).toBeInTheDocument());
    expect(screen.getByTestId("loc-search").textContent).not.toMatch(/perturbation=hackett/);
    // Open the INACTIVE hackett's filter modal and apply a filter.
    openFilterModalFor("Hackett");
    await waitFor(() =>
      expect(document.getElementById("flt-condition-YPD")).toBeInTheDocument(),
    );
    fireEvent.click(document.getElementById("flt-condition-YPD") as HTMLInputElement);
    fireEvent.click(screen.getByRole("button", { name: /Apply Filters/i }));
    // Applying activates hackett under ?perturbation=.
    await waitFor(() => {
      expect(screen.getByTestId("loc-search").textContent).toMatch(/perturbation=hackett/);
    });
  });

  it("retroactive clear still fires when a third active dataset shrinks the field intersection (SD-6c regression)", async () => {
    // harbison + chec_m2025 share `condition`; rossi (active) only has
    // `treatment`, so the live commonFields intersection is EMPTY. The clear
    // must still reach chec_m2025 because it keys off the persisted
    // applyToAll annotation, not the shrunk intersection.
    const THREE = [
      { dbName: "harbison", dataType: "binding", assay: "chip", displayName: "Harbison", sourceRepo: "", sampleIdField: "id", fields: [] },
      { dbName: "chec_m2025", dataType: "binding", assay: "chec", displayName: "ChEC M2025", sourceRepo: "", sampleIdField: "id", fields: [] },
      { dbName: "rossi", dataType: "perturbation", assay: "rnaseq", displayName: "Rossi", sourceRepo: "", sampleIdField: "sample_id", fields: [] },
    ];
    const TREATMENT_FIELD = { field: "treatment", dbType: "VARCHAR", kind: "categorical", role: "experimental_condition", levels: ["Normal", "Stress"] };
    const preset = encodeURIComponent(
      JSON.stringify({
        harbison: { condition: { type: "categorical", value: ["YPD"], applyToAll: true } },
        chec_m2025: { condition: { type: "categorical", value: ["YPD"], applyToAll: true } },
      }),
    );
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.endsWith("/datasets")) return { datasets: THREE };
        if (url.includes("/datasets/harbison/fields")) return { dbName: "harbison", fields: [CONDITION_FIELD] };
        if (url.includes("/datasets/chec_m2025/fields")) return { dbName: "chec_m2025", fields: [CONDITION_FIELD] };
        if (url.includes("/datasets/rossi/fields")) return { dbName: "rossi", fields: [TREATMENT_FIELD] };
        if (url.includes("/regulators")) return { dbName: "x", regulators: [] };
        if (url.includes("/selection/matrix")) return { diagonal: [], crossDataset: [] };
        return {};
      }),
    );
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter
          initialEntries={[
            `/select?binding=harbison,chec_m2025&perturbation=rossi&filters=${preset}`,
          ]}
        >
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Both condition-bearing datasets start badged.
    await waitFor(() => {
      expect(screen.getByTestId("badge-harbison")).toBeInTheDocument();
      expect(screen.getByTestId("badge-chec_m2025")).toBeInTheDocument();
    });
    openFilterModalFor("Harbison");
    await waitFor(() => {
      const ypd = document.getElementById("flt-condition-YPD") as HTMLInputElement;
      expect(ypd.checked).toBe(true);
    });
    fireEvent.click(document.getElementById("flt-condition-YPD") as HTMLInputElement);
    fireEvent.click(screen.getByRole("button", { name: /Apply Filters/i }));
    // The shared filter is cleared from chec_m2025 even though `condition`
    // is no longer in the (rossi-shrunk) commonFields intersection.
    await waitFor(() => {
      expect(screen.queryByTestId("badge-harbison")).toBeNull();
      expect(screen.queryByTestId("badge-chec_m2025")).toBeNull();
    });
  });

  it("the selection matrix refetches and narrows when a regulator filter is applied", async () => {
    // Backend-faithful mock: the matrix narrows to 1 when the request carries
    // a regulator_locus_tag filter, else reports the baseline of 3.
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.endsWith("/datasets")) return { datasets: TWO_DATASETS };
        if (url.includes("/datasets/harbison/fields")) return { dbName: "harbison", fields: [] };
        if (url.includes("/datasets/hackett/fields")) return { dbName: "hackett", fields: [] };
        if (url.includes("/datasets/harbison/regulators")) return { dbName: "harbison", regulators: REGS };
        if (url.includes("/datasets/hackett/regulators")) return { dbName: "hackett", regulators: REGS };
        if (url.includes("/selection/matrix")) {
          const n = url.includes("regulator_locus_tag") ? 1 : 3;
          return {
            diagonal: [
              { dbName: "harbison", nRegulators: n, nSamples: n },
              { dbName: "hackett", nRegulators: n, nSamples: n },
            ],
            crossDataset: [
              { pairId: "harbison__hackett", dbA: "harbison", dbB: "hackett", nCommon: n, samplesA: n, samplesB: n },
            ],
          };
        }
        return {};
      }),
    );
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/select?binding=harbison&perturbation=hackett"]}>
          <Select />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Baseline matrix: 3 regulators on the diagonal.
    await waitFor(() =>
      expect(screen.getAllByText(/3 regulators/).length).toBeGreaterThan(0),
    );
    // Apply a regulator filter via the card.
    openFilterModalFor("Harbison");
    await waitFor(() =>
      expect(screen.getByTestId("regulator-option-YPL248C")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("regulator-option-YPL248C"));
    fireEvent.click(screen.getByRole("button", { name: /Apply Filters/i }));
    // The matrix must re-fetch with the regulator filter and narrow to 1.
    await waitFor(() =>
      expect(screen.getAllByText(/1 regulators/).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(/3 regulators/)).toBeNull();
  });

  it("applying a regulator via the card keeps the ?regulators= side-channel in sync (SD-5 finding #3)", async () => {
    vi.stubGlobal("fetch", fakeFetch(conditionHandler));
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter
          initialEntries={["/select?binding=harbison&perturbation=hackett"]}
        >
          <Select />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("Harbison")).toBeInTheDocument());
    openFilterModalFor("Harbison");
    await waitFor(() =>
      expect(screen.getByTestId("regulator-option-YPL248C")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("regulator-option-YPL248C"));
    fireEvent.click(screen.getByRole("button", { name: /Apply Filters/i }));
    await waitFor(() => {
      expect(screen.getByTestId("loc-search").textContent).toMatch(/regulators=YPL248C/);
    });
  });

  it("'Select N common regulators' writes ?filters= even when regulator_locus_tag is absent from /fields (matrix updates + highlights)", async () => {
    // Realistic: the backend excludes regulator_locus_tag from /datasets/{db}/fields
    // (it is a hidden-but-valid WHERE field, not in field_manifest). The pairwise
    // common-regulators flow must still write the regulator_locus_tag filter to
    // ?filters= so the matrix refetches and the originating cell highlights.
    vi.stubGlobal(
      "fetch",
      fakeFetch((url) => {
        if (url.endsWith("/datasets")) return { datasets: TWO_DATASETS };
        if (url.includes("/datasets/harbison/fields")) return { dbName: "harbison", fields: [] };
        if (url.includes("/datasets/hackett/fields")) return { dbName: "hackett", fields: [] };
        if (url.includes("/regulators/resolve"))
          return { regulators: ["YBR289W", "YGL073W"], truncated: false };
        if (url.includes("/selection/matrix")) {
          return {
            diagonal: [
              { dbName: "harbison", nRegulators: 3, nSamples: 3 },
              { dbName: "hackett", nRegulators: 3, nSamples: 3 },
            ],
            crossDataset: [
              { pairId: "hackett__harbison", dbA: "hackett", dbB: "harbison", nCommon: 3, samplesA: 3, samplesB: 3 },
            ],
          };
        }
        return {};
      }),
    );
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/select?binding=harbison&perturbation=hackett"]}>
          <Select />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Off-diagonal common-regulators cell (datasets sort to [hackett, harbison]).
    await waitFor(() =>
      expect(screen.getByTestId("cell-hackett-harbison")).toBeInTheDocument(),
    );
    const offCell = screen
      .getByTestId("cell-hackett-harbison")
      .querySelector("button");
    if (!offCell) throw new Error("no off-diagonal button");
    fireEvent.click(offCell);
    // CommonRegulatorsModal → wait for the resolve to load so the button is
    // ENABLED (it renders disabled as "Select 0 common regulators" while the
    // /regulators/resolve query is in flight).
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Select [1-9]\d* common regulators/ }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Select [1-9]\d* common regulators/ }),
    );
    // The regulator filter MUST land in ?filters= for both active datasets
    // (badge proves it) — this is what makes the matrix refetch + highlight.
    await waitFor(() => {
      expect(screen.getByTestId("badge-harbison")).toBeInTheDocument();
      expect(screen.getByTestId("badge-hackett")).toBeInTheDocument();
    });
    expect(screen.getByTestId("loc-search").textContent).toMatch(/filters=/);
    // The originating cell is highlighted (from_pair).
    await waitFor(() =>
      expect(
        screen.getByTestId("cell-hackett-harbison").getAttribute("data-highlighted"),
      ).toBe("true"),
    );
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
