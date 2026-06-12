import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Comparison } from "@/routes/Comparison";
import { setArtifactVersion } from "@/api/client";

describe("Comparison route", () => {
  beforeEach(() => {
    setArtifactVersion("test");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ rows: [] }), { status: 200 })),
    );
  });

  it("renders the sidebar controls (Top N, responsiveness preset radios, facet radios)", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/comparison"]}>
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("Top N")).toBeInTheDocument();
    // CMP-4/CMP-5: responsiveness-preset radios replace the old sliders
    expect(screen.getByDisplayValue("Relaxed")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Stringent")).toBeInTheDocument();
    // Old effect/pvalue sliders must NOT be present
    expect(screen.queryByLabelText("Min |effect|")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Max p-value")).not.toBeInTheDocument();
    // Facet radios remain
    expect(screen.getByLabelText("Binding source")).toBeInTheDocument();
    expect(screen.getByLabelText("Perturbation source")).toBeInTheDocument();
  });

  it("defaults to Relaxed preset when no ?preset= param is in the URL", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/comparison"]}>
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const relaxedRadio = screen.getByDisplayValue("Relaxed") as HTMLInputElement;
    const stringentRadio = screen.getByDisplayValue("Stringent") as HTMLInputElement;
    expect(relaxedRadio.checked).toBe(true);
    expect(stringentRadio.checked).toBe(false);
  });

  it("reads ?preset=Stringent from the URL and selects the Stringent radio", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/comparison?preset=Stringent"]}>
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const stringentRadio = screen.getByDisplayValue("Stringent") as HTMLInputElement;
    expect(stringentRadio.checked).toBe(true);
  });

  it("selecting Stringent writes preset=Stringent into the URL state", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/comparison"]}>
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const stringentRadio = screen.getByDisplayValue("Stringent") as HTMLInputElement;
    expect(stringentRadio.checked).toBe(false);
    fireEvent.click(stringentRadio);
    await waitFor(() => expect(stringentRadio.checked).toBe(true));
    // Once Stringent is selected, Relaxed should be unchecked
    const relaxedRadio = screen.getByDisplayValue("Relaxed") as HTMLInputElement;
    expect(relaxedRadio.checked).toBe(false);
  });

  it("renders the empty-state prompt until both binding and perturbation are picked", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/comparison"]}>
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      screen.getByText(/Pick at least one binding and one perturbation dataset/),
    ).toBeInTheDocument();
  });

  it("shows the diagram-shaped loading skeleton while the top_n query is pending", () => {
    // A fetch that never resolves keeps the query in the pending state, which
    // is what the user sees during the multi-second top_n load on real data.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(new Promise<Response>(() => {})),
    );
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter
          initialEntries={[
            "/comparison?binding=callingcards&perturbation=hackett",
          ]}
        >
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      screen.getByLabelText("Loading comparison chart"),
    ).toBeInTheDocument();
  });

  it("renders the backend's readable message (not 'HTTP 400') when the top_n query is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error:
              "too many comparisons: 24 binding×perturbation pairs requested (max 6) — select fewer binding or perturbation datasets",
          }),
          { status: 400 },
        ),
      ),
    );
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter
          initialEntries={[
            "/comparison?binding=a,b,c,d&perturbation=e,f,g,h,i,j",
          ]}
        >
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText(/too many comparisons.*select fewer/),
    ).toBeInTheDocument();
    expect(screen.queryByText("HTTP 400")).not.toBeInTheDocument();
  });

  it("toggling facet_by radio writes to the URL", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/comparison?binding=callingcards&perturbation=hackett"]}>
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const pertRadio = screen.getByLabelText("Perturbation source") as HTMLInputElement;
    expect(pertRadio.checked).toBe(false);
    fireEvent.click(pertRadio);
    await waitFor(() => expect(pertRadio.checked).toBe(true));
  });

  it("sends ?preset=Stringent to the API when Stringent is selected", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ rows: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter
          initialEntries={[
            "/comparison?binding=callingcards&perturbation=hackett&preset=Stringent",
          ]}
        >
          <Comparison />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Wait for the query to fire
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const calledUrl: string = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("preset=Stringent");
    // Must NOT fall back to numeric effect/pvalue params
    expect(calledUrl).not.toContain("effect=");
    expect(calledUrl).not.toContain("pvalue=");
  });
});
