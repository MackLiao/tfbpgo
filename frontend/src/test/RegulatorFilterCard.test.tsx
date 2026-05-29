import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RegulatorFilterCard } from "@/components/RegulatorFilterCard";
import { setArtifactVersion } from "@/api/client";
import type { AnnotatedFilterSpec } from "@/lib/filter-spec";

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

const REGULATORS = [
  { locusTag: "YPL248C", symbol: "GAL4", display: "GAL4 (YPL248C)" },
  { locusTag: "YLR451W", symbol: "LEU3", display: "LEU3 (YLR451W)" },
  { locusTag: "YEL009C", symbol: "GCN4", display: "GCN4 (YEL009C)" },
];

function stubRegulators() {
  vi.stubGlobal(
    "fetch",
    fakeFetch((url) => {
      if (url.includes("/datasets/harbison/regulators")) {
        return { dbName: "harbison", regulators: REGULATORS };
      }
      return {};
    }),
  );
}

interface HarnessProps {
  spec?: AnnotatedFilterSpec | null;
  applyToAll?: boolean;
  onChange?: (next: AnnotatedFilterSpec | null) => void;
  onApplyToAllChange?: (on: boolean) => void;
  onClear?: () => void;
}

function renderCard(props: HarnessProps = {}) {
  const onChange = props.onChange ?? vi.fn();
  const onApplyToAllChange = props.onApplyToAllChange ?? vi.fn();
  const onClear = props.onClear ?? vi.fn();
  render(
    <QueryClientProvider client={makeClient()}>
      <RegulatorFilterCard
        db="harbison"
        spec={props.spec ?? null}
        applyToAll={props.applyToAll ?? true}
        onChange={onChange}
        onApplyToAllChange={onApplyToAllChange}
        onClear={onClear}
      />
    </QueryClientProvider>,
  );
  return { onChange, onApplyToAllChange, onClear };
}

describe("RegulatorFilterCard", () => {
  beforeEach(() => {
    setArtifactVersion("test");
  });

  it("renders SYMBOL (LOCUS_TAG) labels and filters the list by search", async () => {
    stubRegulators();
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId("regulator-option-YPL248C")).toHaveTextContent(
        "GAL4 (YPL248C)",
      );
    });
    expect(screen.getByTestId("regulator-option-YLR451W")).toBeInTheDocument();

    const search = screen.getByTestId("regulator-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "leu" } });
    await waitFor(() => {
      expect(screen.getByTestId("regulator-option-YLR451W")).toBeInTheDocument();
      expect(screen.queryByTestId("regulator-option-YPL248C")).toBeNull();
    });

    // search also matches locus tag
    fireEvent.change(search, { target: { value: "yel009" } });
    await waitFor(() => {
      expect(screen.getByTestId("regulator-option-YEL009C")).toBeInTheDocument();
      expect(screen.queryByTestId("regulator-option-YPL248C")).toBeNull();
    });
  });

  it("clicking an option adds it as a categorical regulator spec", async () => {
    stubRegulators();
    const { onChange } = renderCard();
    await waitFor(() =>
      expect(screen.getByTestId("regulator-option-YPL248C")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("regulator-option-YPL248C"));
    expect(onChange).toHaveBeenCalledWith({
      type: "categorical",
      value: ["YPL248C"],
    });
  });

  it("renders selected tags as removable chips with display labels", async () => {
    stubRegulators();
    const { onChange } = renderCard({
      spec: { type: "categorical", value: ["YPL248C", "YLR451W"] },
    });
    await waitFor(() =>
      expect(screen.getByTestId("regulator-chip-YPL248C")).toHaveTextContent(
        "GAL4 (YPL248C)",
      ),
    );
    // Remove GAL4 → onChange with only LEU3 left.
    const removeBtn = screen
      .getByTestId("regulator-chip-YPL248C")
      .querySelector("button");
    if (!removeBtn) throw new Error("no chip remove button");
    fireEvent.click(removeBtn);
    expect(onChange).toHaveBeenCalledWith({
      type: "categorical",
      value: ["YLR451W"],
    });
  });

  it("removing the last chip clears the spec (onChange null)", async () => {
    stubRegulators();
    const { onChange } = renderCard({
      spec: { type: "categorical", value: ["YPL248C"] },
    });
    await waitFor(() =>
      expect(screen.getByTestId("regulator-chip-YPL248C")).toBeInTheDocument(),
    );
    const removeBtn = screen
      .getByTestId("regulator-chip-YPL248C")
      .querySelector("button");
    if (!removeBtn) throw new Error("no chip remove button");
    fireEvent.click(removeBtn);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows an Apply-to-all toggle reflecting the prop and a Clear button", async () => {
    stubRegulators();
    const { onApplyToAllChange, onClear } = renderCard({ applyToAll: true });
    await waitFor(() =>
      expect(
        screen.getByTestId("apply-to-all-regulator_locus_tag"),
      ).toBeInTheDocument(),
    );
    const cb = document.getElementById(
      "apply-to-all-cb-regulator_locus_tag",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    fireEvent.click(cb);
    expect(onApplyToAllChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByTestId("regulator-clear"));
    expect(onClear).toHaveBeenCalled();
  });

  it("in from_pair mode shows the context note and hides Clear / apply-to-all", async () => {
    stubRegulators();
    renderCard({
      spec: {
        type: "categorical",
        value: ["YPL248C", "YLR451W"],
        fromPair: ["Harbison", "Hackett"],
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId("regulator-from-pair-note")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("regulator-from-pair-note").textContent).toMatch(
      /common regulators between Harbison and Hackett/,
    );
    // Clear button + apply-to-all toggle are not shown in restricted mode.
    expect(screen.queryByTestId("regulator-clear")).toBeNull();
    expect(screen.queryByTestId("apply-to-all-regulator_locus_tag")).toBeNull();
  });
});
