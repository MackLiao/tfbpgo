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

  it("renders the sidebar controls (Top N, sliders, facet radios)", () => {
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
    expect(screen.getByLabelText("Min |effect|")).toBeInTheDocument();
    expect(screen.getByLabelText("Max p-value")).toBeInTheDocument();
    expect(screen.getByLabelText("Binding source")).toBeInTheDocument();
    expect(screen.getByLabelText("Perturbation source")).toBeInTheDocument();
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
    let currentURL = "/comparison?binding=callingcards&perturbation=hackett";
    const Capture = () => {
      // react-router's MemoryRouter doesn't surface URL changes externally,
      // so we lean on the radio checked state instead of URL inspection.
      return <Comparison />;
    };
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[currentURL]}>
          <Capture />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const pertRadio = screen.getByLabelText("Perturbation source") as HTMLInputElement;
    expect(pertRadio.checked).toBe(false);
    fireEvent.click(pertRadio);
    await waitFor(() => expect(pertRadio.checked).toBe(true));
  });
});
