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

// Base (Kang) binding labels, keyed by primary db_name. Spellings are the
// reference's CURRENT canonical forms ("2021 ChIP-exo" / "2025 ChEC-seq" — note
// the hyphen + capital C), matching workspace.py:56-61 `_BINDING_ORDER` and
// queries.py:469-483 `BINDING_LABEL_MAP`. The Task-6a Shiny-port spellings
// ("ChIPexo" / "Chec-seq") were stale; this is the single source of truth that
// `BINDING_PALETTE` / `BINDING_ORDER` / `ComparisonBoxplot` key on.
export const BINDING_LABEL_MAP: Record<string, string> = {
  callingcards: "2026 Calling Cards",
  harbison: "2004 ChIP-chip",
  chec_m2025: "2025 ChEC-seq",
  rossi: "2021 ChIP-exo",
  // Promoter-set variants (suffixed with the promoter set in parentheses) —
  // folded in from the former duplicate BINDING_LABEL_MAP_FULL.
  // queries.py:469-483.
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
  "2021 ChIP-exo": "#F39B7F",
  "2025 ChEC-seq": "#00A087",
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
  "2021 ChIP-exo",
  "2025 ChEC-seq",
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

// (The former `BINDING_LABEL_MAP_FULL` was folded into the single
// `BINDING_LABEL_MAP` above — there is now one binding-label map keyed on the
// reference's canonical spellings, covering both the base datasets and their
// promoter-set variants. queries.py:469-483.)

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

// ---------------------------------------------------------------------------
// Promoter-set ordering / variant-tab helpers (Task 6b).
// ---------------------------------------------------------------------------

// Promoter-set keys in selector order. workspace.py:67-72 `_PROMOTER_SET_ALIAS`
// (Kang, Mindel, 500bp, Intergenic). Drives the Compare Promoter Definitions
// table column order; index aligns with PROMOTER_VARIANT_PAIRS for non-Kang sets
// ("Mindel"→0, "500bp"→1, "Intergenic"→2 — Kang is the primary db itself).
export const PROMOTER_SET_ORDER: ReadonlyArray<string> = [
  "Kang",
  "Mindel",
  "500bp",
  "Intergenic",
];

// Index of each non-Kang promoter set into PROMOTER_VARIANT_PAIRS[primary].
// workspace.py:774-778 `_ps_to_variant_index`.
export const PROMOTER_SET_VARIANT_INDEX: Record<string, number> = {
  Mindel: 0,
  "500bp": 1,
  Intergenic: 2,
};

// Binding primaries eligible for the Compare Analysis Methods tab — the keys of
// PEAKS_VARIANT_MAP. workspace.py:64 `_METHODS_ELIGIBLE = frozenset(PEAKS_VARIANT_MAP)`.
export const METHODS_ELIGIBLE: ReadonlyArray<string> = Object.keys(
  PEAKS_VARIANT_MAP,
);

// All non-primary promoter-set variant db_names (Mindel/500bp/Intergenic of every
// primary). Used to strip variants out of the user-selected primary binding list.
// workspace.py:316-319 `_variant_dbs`.
export const PROMOTER_VARIANT_DBS: ReadonlySet<string> = new Set(
  Object.values(PROMOTER_VARIANT_PAIRS).flat(),
);

// All peaks variant db_names. workspace.py:336/529 frozenset().union(*PEAKS_VARIANT_MAP.values()).
export const PEAKS_VARIANT_DBS: ReadonlySet<string> = new Set(
  Object.values(PEAKS_VARIANT_MAP).flat(),
);

// HSL green scale for table cells: 0% → white, 100% → full green. Mirrors
// workspace.py:1157-1164 `_cell_style` so the variant tables shade identically
// to the Compare Datasets matrix. Returns a CSS `background-color` string.
export function cellGreenBg(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const lightness = 100 - clamped * 0.5;
  return `hsl(120, 60%, ${Math.round(lightness)}%)`;
}

// Resolve a primary binding db_name + promoter-set key to the variant db_name
// that should be queried/displayed for that cell. "Kang" → the primary db
// itself; other sets → PROMOTER_VARIANT_PAIRS[primary][index], when it exists.
// Returns null when the variant is unknown. Mirrors the Kang/index branch of
// workspace.py:780-793 (`_resolve_cd_db`) and the cp expansion (805-816).
export function resolvePromoterVariant(
  primary: string,
  promoterSet: string,
): string | null {
  if (promoterSet === "Kang") return primary;
  const idx = PROMOTER_SET_VARIANT_INDEX[promoterSet];
  if (idx === undefined) return null;
  const variants = PROMOTER_VARIANT_PAIRS[primary];
  if (!variants || idx >= variants.length) return null;
  return variants[idx] ?? null;
}
