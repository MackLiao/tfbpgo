// Tiny helper for sorting categorical filter levels.
//
// Honors `field_manifest.numeric_level_sort` (schema v4):
//   "numeric" → parse each label as a number and sort ascending; labels
//               that don't parse cleanly fall back to a string-compare tail
//               so the result is still deterministic.
//   "string" / "" / undefined → plain lexicographic sort.
//
// Mirrors the intent of Shiny's `FIELD_TYPE_OVERRIDES` numeric-sort flag
// (the `hackett.time` field renders ["10", "45", "90"] not
// ["10", "45", "90"] lex-wrong-when-three-digits etc.).

export type LevelSortMode = "" | "numeric" | "string" | undefined;

export function sortLevels(levels: readonly string[], mode: LevelSortMode): string[] {
  const arr = [...levels];
  if (mode !== "numeric") {
    return arr.sort();
  }
  // Stable numeric sort with non-numeric strings shoved to the tail
  // (still string-sorted among themselves for determinism).
  return arr.sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    const aOk = Number.isFinite(na);
    const bOk = Number.isFinite(nb);
    if (aOk && bOk) return na - nb;
    if (aOk) return -1;
    if (bOk) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
