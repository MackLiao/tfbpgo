// Sort + dedupe query keys so two equivalent URLs hash to the same key.
export function canonicalParams(p: URLSearchParams): URLSearchParams {
  const entries = [...p.entries()].sort(([a], [b]) => a.localeCompare(b));
  const out = new URLSearchParams();
  for (const [k, v] of entries) out.append(k, v);
  return out;
}

// Compact filter encoding: backend resolver handles `common=` / `intersect=`.
// Frontend's job here is just hard-cap and dedupe.
export function packRegulators(tags: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const x = t.trim().toUpperCase();
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= 30) break; // matches backend maxExplicitTags
  }
  return out.join(",");
}
