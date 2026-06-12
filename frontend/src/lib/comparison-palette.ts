// Comparison module color palette + db_name → display label maps.
//
// Verbatim mirror of
// reference/tfbpshiny/modules/comparison/server/workspace.py:46-95 and
// reference/tfbpshiny/modules/comparison/queries.py:436-563.
//
// The label maps translate `db_name` (storage identifier, e.g. "callingcards")
// into the human-readable, chronologically-prefixed display label
// (e.g. "2026 Calling Cards") that drives both x-axis ticks and palette
// lookup. The palettes are keyed on the *display label*, so the rendering
// path is db_name → label → color.

export const BINDING_LABEL_MAP: Record<string, string> = {
  callingcards: "2026 Calling Cards",
  harbison: "2004 ChIP-chip",
  chec_m2025: "2025 Chec-seq",
  rossi: "2021 ChIPexo",
};

export const PERTURBATION_LABEL_MAP: Record<string, string> = {
  hackett: "2020 Overexpression",
  hughes_overexpression: "2006 Overexpression",
  hughes_knockout: "2006 TFKO",
  hu_reimand: "2007 TFKO",
  kemmeren: "2014 TFKO",
  degron: "2025 Degron",
};

export const BINDING_PALETTE: Record<string, string> = {
  "2004 ChIP-chip": "#E64B35",
  "2021 ChIPexo": "#F39B7F",
  "2025 Chec-seq": "#00A087",
  "2026 Calling Cards": "#3C5488",
};

export const PERTURBATION_PALETTE: Record<string, string> = {
  "2006 Overexpression": "#F39B7F",
  "2006 TFKO": "#00A087",
  "2007 TFKO": "#8491B4",
  "2014 TFKO": "#4DBBD5",
  "2020 Overexpression": "#91D1C2",
  "2025 Degron": "#B09C85",
};

// Display-order constants — chronological ordering that drives both facet
// column order and within-facet x-axis order. Mirrors `_BINDING_ORDER` and
// `_PERT_ORDER` in workspace.py:46-60.
export const BINDING_ORDER: ReadonlyArray<string> = [
  "2004 ChIP-chip",
  "2021 ChIPexo",
  "2025 Chec-seq",
  "2026 Calling Cards",
];

export const PERTURBATION_ORDER: ReadonlyArray<string> = [
  "2006 Overexpression",
  "2006 TFKO",
  "2007 TFKO",
  "2014 TFKO",
  "2020 Overexpression",
  "2025 Degron",
];

// ---------------------------------------------------------------------------
// Promoter-set-aware maps (CMP-6 / Task 6a).
//
// The reference restructured the Comparison tab into a 3-tab navset where the
// "Compare Promoter Definitions" and "Compare Analysis Methods" tabs label the
// SAME `/comparison/topn` results by promoter-set variant / scoring variant.
// These maps mirror reference/tfbpshiny/modules/comparison/queries.py:436-554
// verbatim so the follow-up sub-task that builds those two tabs already has the
// authoritative display strings + ordering + palette. The Compare Datasets tab
// (this sub-task) needs the base/full binding labels for matrix-cell hover and
// fallback labelling.
// ---------------------------------------------------------------------------

// Maps every binding db_name to its base label (promoter-set suffix stripped);
// all promoter variants of the same dataset share the same base label.
// queries.py:436-450 BINDING_BASE_LABEL_MAP.
export const BINDING_BASE_LABEL_MAP: Record<string, string> = {
  callingcards: "2026 Calling Cards",
  callingcards_mindel: "2026 Calling Cards",
  callingcards_500bp: "2026 Calling Cards",
  callingcards_intergenic: "2026 Calling Cards",
  harbison: "2004 ChIP-chip",
  rossi: "2021 ChIP-exo",
  rossi_mindel: "2021 ChIP-exo",
  rossi_500bp: "2021 ChIP-exo",
  rossi_intergenic: "2021 ChIP-exo",
  chec_m2025: "2025 ChEC-seq",
  chec_m2025_mindel: "2025 ChEC-seq",
  chec_m2025_500bp: "2025 ChEC-seq",
  chec_m2025_intergenic: "2025 ChEC-seq",
};

// Maps every binding db_name to its promoter-set label.
// queries.py:453-467 PROMOTER_SET_MAP.
export const PROMOTER_SET_MAP: Record<string, string> = {
  callingcards: "Kang",
  callingcards_mindel: "Mindel",
  callingcards_500bp: "500bp",
  callingcards_intergenic: "Intergenic",
  harbison: "Kang",
  rossi: "Kang",
  rossi_mindel: "Mindel",
  rossi_500bp: "500bp",
  rossi_intergenic: "Intergenic",
  chec_m2025: "Kang",
  chec_m2025_mindel: "Mindel",
  chec_m2025_500bp: "500bp",
  chec_m2025_intergenic: "Intergenic",
};

// Full binding label map, extended with the promoter-set variants (each variant
// suffixed with its promoter set in parentheses). queries.py:469-483
// BINDING_LABEL_MAP. Note: this is the variant-extended superset; the base-only
// BINDING_LABEL_MAP above (kept for the Compare Datasets boxplot facet titles)
// uses the Shiny-port spellings ("ChIPexo"/"Chec-seq") that the existing
// ComparisonBoxplot + BINDING_PALETTE are keyed on. The variant map below uses
// the reference's canonical spellings ("ChIP-exo"/"ChEC-seq").
export const BINDING_LABEL_MAP_FULL: Record<string, string> = {
  callingcards: "2026 Calling Cards",
  harbison: "2004 ChIP-chip",
  chec_m2025: "2025 ChEC-seq",
  rossi: "2021 ChIP-exo",
  chec_m2025_mindel: "2025 ChEC-seq (Mindel)",
  rossi_mindel: "2021 ChIP-exo (Mindel)",
  callingcards_mindel: "2026 Calling Cards (Mindel)",
  rossi_500bp: "2021 ChIP-exo (500bp)",
  chec_m2025_500bp: "2025 ChEC-seq (500bp)",
  rossi_intergenic: "2021 ChIP-exo (Intergenic)",
  chec_m2025_intergenic: "2025 ChEC-seq (Intergenic)",
  callingcards_500bp: "2026 Calling Cards (500bp)",
  callingcards_intergenic: "2026 Calling Cards (Intergenic)",
};

// Maps primary binding db_name to its ordered promoter-set variants, in the
// promoter-selector order: Mindel, 500bp, Intergenic (Kang is the primary
// db_name itself, not listed here). queries.py:488-496 PROMOTER_VARIANT_PAIRS.
export const PROMOTER_VARIANT_PAIRS: Record<string, ReadonlyArray<string>> = {
  rossi: ["rossi_mindel", "rossi_500bp", "rossi_intergenic"],
  chec_m2025: [
    "chec_m2025_mindel",
    "chec_m2025_500bp",
    "chec_m2025_intergenic",
  ],
  callingcards: [
    "callingcards_mindel",
    "callingcards_500bp",
    "callingcards_intergenic",
  ],
};

// ---------------------------------------------------------------------------
// Compare Analysis Methods constants. queries.py:504-554.
// Ported now so the follow-up sub-task can build the Methods tab without
// re-deriving the maps; not consumed by the Compare Datasets matrix.
// ---------------------------------------------------------------------------

// Base label per method-tab binding db_name (all scoring variants share it).
// queries.py:504-515 METHOD_BASE_LABEL_MAP.
export const METHOD_BASE_LABEL_MAP: Record<string, string> = {
  chec_m2025: "2025 ChEC-seq",
  chec_m2025_mindel: "2025 ChEC-seq",
  chec_m2025_500bp: "2025 ChEC-seq",
  chec_m2025_intergenic: "2025 ChEC-seq",
  chec_m2025_peaks: "2025 ChEC-seq",
  rossi: "2021 ChIP-exo",
  rossi_mindel: "2021 ChIP-exo",
  rossi_500bp: "2021 ChIP-exo",
  rossi_intergenic: "2021 ChIP-exo",
  rossi_peaks: "2021 ChIP-exo",
};

// Human-readable label for each scoring variant. queries.py:518-529
// SCORING_VARIANT_MAP.
export const SCORING_VARIANT_MAP: Record<string, string> = {
  chec_m2025: "Promoter Enrichment (Kang)",
  chec_m2025_mindel: "Promoter Enrichment (Mindel)",
  chec_m2025_500bp: "Promoter Enrichment (500bp)",
  chec_m2025_intergenic: "Promoter Enrichment (Intergenic)",
  chec_m2025_peaks: "Original Peaks",
  rossi: "Promoter Enrichment (Kang)",
  rossi_mindel: "Promoter Enrichment (Mindel)",
  rossi_500bp: "Promoter Enrichment (500bp)",
  rossi_intergenic: "Promoter Enrichment (Intergenic)",
  rossi_peaks: "Original Peaks",
};

// Maps each primary binding dataset to its peaks (original-publication) variant.
// queries.py:533-536 PEAKS_VARIANT_MAP.
export const PEAKS_VARIANT_MAP: Record<string, ReadonlyArray<string>> = {
  rossi: ["rossi_peaks"],
  chec_m2025: ["chec_m2025_peaks"],
};

// Display order for scoring variants within a subplot/table.
// queries.py:539-545 SCORING_VARIANT_ORDER.
export const SCORING_VARIANT_ORDER: ReadonlyArray<string> = [
  "Promoter Enrichment (Kang)",
  "Promoter Enrichment (Mindel)",
  "Promoter Enrichment (500bp)",
  "Promoter Enrichment (Intergenic)",
  "Original Peaks",
];

// Color palette for scoring variants (keyed on the display label).
// queries.py:548-554 SCORING_VARIANT_COLORS.
export const SCORING_VARIANT_COLORS: Record<string, string> = {
  "Promoter Enrichment (Kang)": "#4DBBD5",
  "Promoter Enrichment (Mindel)": "#00A087",
  "Promoter Enrichment (500bp)": "#7B4F9E",
  "Promoter Enrichment (Intergenic)": "#F39B7F",
  "Original Peaks": "#E64B35",
};

export const FALLBACK_COLOR = "#888888";

export function bindingLabel(db: string): string {
  return BINDING_LABEL_MAP[db] ?? db;
}

export function perturbationLabel(db: string): string {
  return PERTURBATION_LABEL_MAP[db] ?? db;
}
