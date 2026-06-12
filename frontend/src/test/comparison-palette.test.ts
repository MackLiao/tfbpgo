import { describe, it, expect } from "vitest";
import { resolveCompareDatasetsDb } from "@/lib/comparison-palette";

// Unit coverage for the Compare Datasets row resolver — verbatim parity with the
// reference `_resolve_cd_db` (workspace.py:780-793). The asymmetry between the
// two methods is the load-bearing behaviour: Promoter Enrichment never drops a
// primary (it degrades to Kang), whereas Peaks drops a primary that has no peaks
// variant (returns null → the row is removed from the matrix).
describe("resolveCompareDatasetsDb", () => {
  it("Promoter Enrichment + Kang resolves to the primary itself", () => {
    expect(resolveCompareDatasetsDb("rossi", "Promoter Enrichment", "Kang")).toBe(
      "rossi",
    );
    expect(
      resolveCompareDatasetsDb("harbison", "Promoter Enrichment", "Kang"),
    ).toBe("harbison");
    expect(
      resolveCompareDatasetsDb("callingcards", "Promoter Enrichment", "Kang"),
    ).toBe("callingcards");
  });

  it("Promoter Enrichment + Mindel/500bp/Intergenic resolves to the indexed variant", () => {
    expect(
      resolveCompareDatasetsDb("rossi", "Promoter Enrichment", "Mindel"),
    ).toBe("rossi_mindel");
    expect(
      resolveCompareDatasetsDb("rossi", "Promoter Enrichment", "500bp"),
    ).toBe("rossi_500bp");
    expect(
      resolveCompareDatasetsDb("rossi", "Promoter Enrichment", "Intergenic"),
    ).toBe("rossi_intergenic");
    expect(
      resolveCompareDatasetsDb("chec_m2025", "Promoter Enrichment", "Mindel"),
    ).toBe("chec_m2025_mindel");
    expect(
      resolveCompareDatasetsDb("callingcards", "Promoter Enrichment", "500bp"),
    ).toBe("callingcards_500bp");
  });

  it("Promoter Enrichment falls back to the primary when the set has no variant", () => {
    // harbison (2004 ChIP-chip) has no promoter-set variants → degrade to Kang.
    expect(
      resolveCompareDatasetsDb("harbison", "Promoter Enrichment", "Mindel"),
    ).toBe("harbison");
    expect(
      resolveCompareDatasetsDb("harbison", "Promoter Enrichment", "Intergenic"),
    ).toBe("harbison");
  });

  it("Peaks resolves to the peaks variant, ignoring the promoter set", () => {
    expect(resolveCompareDatasetsDb("rossi", "Peaks", "Kang")).toBe("rossi_peaks");
    // The promoter set is irrelevant under Peaks (reference returns the peaks
    // variant regardless of cd_promoter_set).
    expect(resolveCompareDatasetsDb("chec_m2025", "Peaks", "Mindel")).toBe(
      "chec_m2025_peaks",
    );
  });

  it("Peaks returns null (drops the row) for primaries with no peaks variant", () => {
    expect(resolveCompareDatasetsDb("harbison", "Peaks", "Kang")).toBeNull();
    expect(resolveCompareDatasetsDb("callingcards", "Peaks", "Kang")).toBeNull();
  });

  // The optional `available` set mirrors the reference's `_available_datasets`
  // guard (workspace.py:790-792) + the `cd_resolved in BINDING_CONFIGS` filter:
  // a resolved db absent from the artifact degrades (PE → primary) or drops.
  it("gates resolved dbs on the available-dataset set (reference _available_datasets)", () => {
    const avail = new Set(["rossi", "rossi_mindel"]); // rossi_500bp / peaks absent
    // Available variant → returned as-is.
    expect(
      resolveCompareDatasetsDb("rossi", "Promoter Enrichment", "Mindel", avail),
    ).toBe("rossi_mindel");
    // Unavailable variant → fall back to the primary (Kang), which IS available.
    expect(
      resolveCompareDatasetsDb("rossi", "Promoter Enrichment", "500bp", avail),
    ).toBe("rossi");
    // Primary itself not available → dropped (null).
    expect(
      resolveCompareDatasetsDb("chec_m2025", "Promoter Enrichment", "Kang", avail),
    ).toBeNull();
    // Peaks variant not in the available set → dropped.
    expect(resolveCompareDatasetsDb("rossi", "Peaks", "Kang", avail)).toBeNull();
  });

  it("applies no gating when the available set is omitted (static maps win)", () => {
    // Backward-compatible default: undefined `available` => behave as before.
    expect(
      resolveCompareDatasetsDb("rossi", "Promoter Enrichment", "500bp"),
    ).toBe("rossi_500bp");
    expect(resolveCompareDatasetsDb("rossi", "Peaks", "Kang")).toBe("rossi_peaks");
  });
});
