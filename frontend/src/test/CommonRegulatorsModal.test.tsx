import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommonRegulatorsModal } from "@/components/CommonRegulatorsModal";
import { setArtifactVersion } from "@/api/client";

beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  }
  setArtifactVersion("test");
});

function fakeFetch(handler: (url: string) => unknown) {
  return vi.fn((url: string) =>
    Promise.resolve(new Response(JSON.stringify(handler(url) ?? {}), { status: 200 })),
  );
}
function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderModal(filters: string, onSelectCommon = vi.fn()) {
  vi.stubGlobal(
    "fetch",
    fakeFetch((url) =>
      url.includes("/regulators/resolve")
        ? { regulators: ["YBR289W", "YGL073W", "YML007W"], truncated: false }
        : {},
    ),
  );
  render(
    <QueryClientProvider client={makeClient()}>
      <CommonRegulatorsModal
        open
        onClose={() => {}}
        dbA="callingcards"
        dbB="hackett"
        displayA="Calling Cards"
        displayB="Hackett"
        filters={filters}
        onSelectCommon={onSelectCommon}
      />
    </QueryClientProvider>,
  );
  return onSelectCommon;
}

describe("CommonRegulatorsModal", () => {
  it("intersects the resolved common set with the active regulator filter so it matches the cell", async () => {
    const filters = JSON.stringify({
      callingcards: { regulator_locus_tag: { type: "categorical", value: ["YBR289W"] } },
      hackett: { regulator_locus_tag: { type: "categorical", value: ["YBR289W"] } },
    });
    const onSel = renderModal(filters);
    // Resolve returns 3, but the regulator filter narrows the display to 1.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Select 1 common regulators/ }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("YBR289W")).toBeInTheDocument();
    expect(screen.queryByText("YGL073W")).toBeNull();
    expect(screen.queryByText("YML007W")).toBeNull();
    // Selecting applies the filtered set.
    fireEvent.click(screen.getByRole("button", { name: /Select 1 common regulators/ }));
    expect(onSel).toHaveBeenCalledWith(["YBR289W"], ["Calling Cards", "Hackett"]);
  });

  it("shows the full common set when no regulator filter is active", async () => {
    renderModal("");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Select 3 common regulators/ }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("YGL073W")).toBeInTheDocument();
  });
});
