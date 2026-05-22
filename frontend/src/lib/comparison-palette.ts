// Comparison module color palette + db_name → display label maps.
//
// Verbatim mirror of
// reference/tfbpshiny/modules/comparison/server/workspace.py:30-60 and
// reference/tfbpshiny/modules/comparison/queries.py:339-353.
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

export const FALLBACK_COLOR = "#888888";

export function bindingLabel(db: string): string {
  return BINDING_LABEL_MAP[db] ?? db;
}

export function perturbationLabel(db: string): string {
  return PERTURBATION_LABEL_MAP[db] ?? db;
}
