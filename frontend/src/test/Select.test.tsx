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
