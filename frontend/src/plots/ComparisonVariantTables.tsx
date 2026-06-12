import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  api,
  apiErrorMessage,
  type ResponsivenessPreset,
  type Schemas,
} from "@/api/client";
import { qk } from "@/lib/query-keys";
import { cellPercent } from "@/plots/TopNMatrix";
import {
  BINDING_BASE_LABEL_MAP,
  BINDING_ORDER,
  METHOD_BASE_LABEL_MAP,
  PEAKS_VARIANT_MAP,
  PROMOTER_SET_MAP,
  PROMOTER_SET_ORDER,
  PROMOTER_VARIANT_PAIRS,
  SCORING_VARIANT_COLORS,
  SCORING_VARIANT_MAP,
  SCORING_VARIANT_ORDER,
  cellGreenBg,
  perturbationLabel,
  resolvePromoterVariant,
} from "@/lib/comparison-palette";

// Compare Promoter Definitions (Tab 2) + Compare Analysis Methods (Tab 3).
//
// Both tabs are driven by the SAME /comparison/topn endpoint as the Compare
// Datasets matrix — they relabel/regroup the SAME two-stage median over the
// promoter-set / scoring VARIANT binding datasets (now whitelisted in the
// artifact). No backend change.
//
// Parity reference:
//   reference/tfbpshiny/modules/comparison/ui.py:172-182  (the two nav panels)
//   reference/tfbpshiny/modules/comparison/server/workspace.py
//     :198-235  _label_cp_slice  (cp row/col labeling)
//     :238-274  _label_cm_slice  (cm scoring-variant labeling)
//     :802-841  the cp `expanded` / cm `all_method_dbs` enumeration
//     :894-937  per-perturbation `_slice_queue` batching
//     :1402-1567 the cp table render (flex-wrapped one-table-per-perturbation)
//     :1574-1735 the cm table render
//
// ---------------------------------------------------------------------------
// Batching strategy (stays under the backend's 12-pair cap)
// ---------------------------------------------------------------------------
// The reference computes one `topn_all_pairs_sql` call PER perturbation dataset
// (its `_slice_queue` holds the remaining perturbations; each slice runs
// [all binding variant dbs] × [a SINGLE perturbation] — workspace.py:894-937).
// We mirror that exactly with `useQueries`: one query per perturbation dataset,
// each requesting (all relevant binding-variant dbs) × [one perturbation].
//
// Why this keeps every request ≤ 12 pairs (`defaultMaxComparisonPairs`):
//   - cp: the binding axis is `expanded` = (≤3 variant-bearing primaries) ×
//     (≤4 promoter sets) = at most 12 binding dbs, × 1 perturbation = ≤12.
//   - cm: the binding axis is a SINGLE primary's [Kang + ≤3 promoter variants +
//     1 peaks] = at most 5 binding dbs, × 1 perturbation = ≤5.
// Slicing per-perturbation (rather than per-primary-group) matches the reference
// and gives one stable, independently-cached query per (tab, bindings, pert).

// Stable, sorted binding-variant list → cache key survives param-order
// permutation and lets identical slices coalesce across tabs/cards.
function sortedKey(dbs: string[]): string[] {
  return [...dbs].sort();
}

// Index topn rows by pairKey ("{bindingDB}__{perturbationDB}") so a cell can
// pull just its slice. Mirrors the `raw[raw["pair_key"] == pair_key]` filter in
// _label_cp_slice / _label_cm_slice (workspace.py:216-218 / 256-258).
function rowsForPair(
  resp: Schemas["TopNResponse"] | undefined,
  bindingDb: string,
  perturbationDb: string,
): Schemas["TopNRow"][] {
  if (!resp) return [];
  const key = `${bindingDb}__${perturbationDb}`;
  return (resp.rows ?? []).filter((r) => r.pairKey === key);
}

function formatCell(pct: number | null): string {
  return pct === null ? "—" : `${pct.toFixed(1)}%`;
}

// ===========================================================================
// Compare Promoter Definitions (Tab 2)
// ===========================================================================

export interface PromoterDefinitionsTableProps {
  /** Selected PRIMARY binding db_names (variants already stripped). */
  bindingPrimaries: string[];
  /** Selected perturbation db_names. */
  perturbationDatasets: string[];
  topN: number;
  preset: ResponsivenessPreset;
  filters: string;
}

// Expand each selected primary across every promoter set (Kang + Mindel/500bp/
// Intergenic where the variant exists). Mirrors workspace.py:805-816.
function expandPromoterBindings(primaries: string[]): string[] {
  const out: string[] = [];
  for (const primary of primaries) {
    for (const ps of PROMOTER_SET_ORDER) {
      const variant = resolvePromoterVariant(primary, ps);
      if (variant) out.push(variant);
    }
  }
  // Dedupe while preserving order (a primary with no variants still yields Kang).
  return [...new Set(out)];
}

export function PromoterDefinitionsTable({
  bindingPrimaries,
  perturbationDatasets,
  topN,
  preset,
  filters,
}: PromoterDefinitionsTableProps) {
  // Binding axis: only primaries that actually have promoter variants
  // (PROMOTER_VARIANT_PAIRS keys) — harbison has none and is excluded, matching
  // the reference's `expanded` (Kang + variants only exist for rossi/chec/cc).
  const variantPrimaries = useMemo(
    () => bindingPrimaries.filter((b) => b in PROMOTER_VARIANT_PAIRS),
    [bindingPrimaries],
  );
  const expanded = useMemo(
    () => expandPromoterBindings(variantPrimaries),
    [variantPrimaries],
  );

  // One topn slice per perturbation: expanded bindings × this one perturbation.
  const queries = useQueries({
    queries: perturbationDatasets.map((p) => ({
      queryKey: qk.topnSlice(
        "promoters",
        sortedKey(expanded),
        p,
        topN,
        preset,
        filters,
      ),
      queryFn: ({ signal }: { signal: AbortSignal }) => {
        const base = {
          binding: expanded,
          perturbation: [p],
          top_n: topN,
          preset,
        };
        return api.topn(filters ? { ...base, filters } : base, signal);
      },
      enabled: expanded.length > 0,
    })),
  });

  if (variantPrimaries.length === 0) {
    return (
      <EmptyState>
        Select a binding dataset with promoter variants (ChIP-exo, ChEC-seq, or
        Calling Cards) to compare promoter definitions.
      </EmptyState>
    );
  }
  if (perturbationDatasets.length === 0) {
    return <EmptyState>No perturbation datasets selected.</EmptyState>;
  }

  // Binding base labels present, in canonical order (workspace.py:1433-1435).
  const baseLabelsInOrder = BINDING_ORDER.filter((lbl) =>
    expanded.some((db) => BINDING_BASE_LABEL_MAP[db] === lbl),
  );

  return (
    <div className="mt-2 flex flex-wrap gap-6" data-testid="cp-tables">
      {perturbationDatasets.map((p, i) => {
        const q = queries[i];
        const pertLabel = perturbationLabel(p);
        if (q?.isPending) {
          return (
            <TableCard key={p} header={pertLabel}>
              <LoadingRow testid={`cp-loading-${p}`} />
            </TableCard>
          );
        }
        if (q?.isError) {
          // A failed slice (e.g. the backend's 12-pair cap → 400) must surface
          // the backend's readable message — NOT a silent all-"—" table that
          // looks like "computed, no responsive targets". See apiErrorMessage.
          return (
            <TableCard key={p} header={pertLabel} testid={`cp-card-${p}`}>
              <ErrorRow
                testid={`cp-error-${p}`}
                message={apiErrorMessage(q.error)}
              />
            </TableCard>
          );
        }
        const resp = q?.data;
        return (
          <TableCard key={p} header={pertLabel} testid={`cp-card-${p}`}>
            <table className="w-full border-collapse text-sm" data-testid={`cp-table-${p}`}>
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-2.5 py-1.5 text-left">Binding Dataset</th>
                  {PROMOTER_SET_ORDER.map((ps) => (
                    <th key={ps} className="px-2.5 py-1.5 text-right">
                      {ps}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {baseLabelsInOrder.map((baseLabel) => (
                  <tr key={baseLabel}>
                    <td className="whitespace-nowrap px-2.5 py-1.5 text-left">
                      {baseLabel}
                    </td>
                    {PROMOTER_SET_ORDER.map((ps) => {
                      // Resolve (base label → primary db) then (primary, ps) →
                      // variant db. We find the primary whose base label matches.
                      const primary = variantPrimaries.find(
                        (db) => BINDING_BASE_LABEL_MAP[db] === baseLabel,
                      );
                      const variantDb = primary
                        ? resolvePromoterVariant(primary, ps)
                        : null;
                      const pct =
                        variantDb && PROMOTER_SET_MAP[variantDb] === ps
                          ? cellPercent(rowsForPair(resp, variantDb, p))
                          : null;
                      return (
                        <Cell
                          key={ps}
                          pct={pct}
                          testid={`cp-cell-${p}-${baseLabel}-${ps}`}
                        />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableCard>
        );
      })}
    </div>
  );
}

// ===========================================================================
// Compare Analysis Methods (Tab 3)
// ===========================================================================

export interface AnalysisMethodsTableProps {
  bindingPrimaries: string[];
  perturbationDatasets: string[];
  topN: number;
  preset: ResponsivenessPreset;
  filters: string;
}

// All scoring-variant binding dbs for one primary: Kang (the primary itself) +
// its promoter variants + its peaks variant. Mirrors workspace.py:818-841
// (`all_method_dbs`), defaulting all promoter sets selected.
function methodDbsFor(primary: string): string[] {
  const out: string[] = [primary];
  for (const v of PROMOTER_VARIANT_PAIRS[primary] ?? []) out.push(v);
  for (const v of PEAKS_VARIANT_MAP[primary] ?? []) out.push(v);
  return out.filter((db) => db in METHOD_BASE_LABEL_MAP);
}

export function AnalysisMethodsTable({
  bindingPrimaries,
  perturbationDatasets,
  topN,
  preset,
  filters,
}: AnalysisMethodsTableProps) {
  // Peaks-eligible primaries the user selected (rossi, chec_m2025).
  const eligible = useMemo(
    () => bindingPrimaries.filter((b) => b in PEAKS_VARIANT_MAP),
    [bindingPrimaries],
  );

  // One group per eligible primary; within a group, one topn slice per
  // perturbation over [that primary's method variant dbs] × [one perturbation].
  // (≤5 bindings × 1 pert = ≤5 pairs/request.) Flatten to a single useQueries
  // call so hook order is stable; index back via (primary, perturbation).
  const flat = useMemo(
    () =>
      eligible.flatMap((primary) =>
        perturbationDatasets.map((p) => ({
          primary,
          perturbation: p,
          dbs: methodDbsFor(primary),
        })),
      ),
    [eligible, perturbationDatasets],
  );

  const queries = useQueries({
    queries: flat.map(({ primary, perturbation, dbs }) => ({
      queryKey: qk.topnSlice(
        `methods:${primary}`,
        sortedKey(dbs),
        perturbation,
        topN,
        preset,
        filters,
      ),
      queryFn: ({ signal }: { signal: AbortSignal }) => {
        const base = {
          binding: dbs,
          perturbation: [perturbation],
          top_n: topN,
          preset,
        };
        return api.topn(filters ? { ...base, filters } : base, signal);
      },
      enabled: dbs.length > 0,
    })),
  });

  if (eligible.length === 0) {
    return (
      <EmptyState>
        Select ChIP-exo (Rossi 2021) or ChEC-seq (Mahendrawada 2025) to compare
        promoter-enrichment scoring against the original peaks calls.
      </EmptyState>
    );
  }
  if (perturbationDatasets.length === 0) {
    return <EmptyState>No perturbation datasets selected.</EmptyState>;
  }

  // Quick lookup from (primary, perturbation) → query result.
  const respFor = (primary: string, p: string): Schemas["TopNResponse"] | undefined => {
    const idx = flat.findIndex(
      (f) => f.primary === primary && f.perturbation === p,
    );
    return idx >= 0 ? queries[idx]?.data : undefined;
  };
  const pendingFor = (primary: string, p: string): boolean => {
    const idx = flat.findIndex(
      (f) => f.primary === primary && f.perturbation === p,
    );
    return idx >= 0 ? Boolean(queries[idx]?.isPending) : false;
  };
  // A failed slice (e.g. the backend's 12-pair cap → 400) returns its thrown
  // error so the card can surface the backend's readable message instead of a
  // silent all-"—" table. Returns undefined when the slice has not errored.
  const errorFor = (primary: string, p: string): unknown => {
    const idx = flat.findIndex(
      (f) => f.primary === primary && f.perturbation === p,
    );
    return idx >= 0 && queries[idx]?.isError ? queries[idx]?.error : undefined;
  };

  return (
    <div className="mt-2 space-y-6" data-testid="cm-groups">
      {eligible.map((primary) => (
        <div key={primary} data-testid={`cm-group-${primary}`}>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">
            {METHOD_BASE_LABEL_MAP[primary] ?? primary}
          </h3>
          <div className="flex flex-wrap gap-6">
            {perturbationDatasets.map((p) => {
              const pertLabel = perturbationLabel(p);
              if (pendingFor(primary, p)) {
                return (
                  <TableCard key={p} header={pertLabel}>
                    <LoadingRow testid={`cm-loading-${primary}-${p}`} />
                  </TableCard>
                );
              }
              const err = errorFor(primary, p);
              if (err !== undefined) {
                return (
                  <TableCard
                    key={p}
                    header={pertLabel}
                    testid={`cm-card-${primary}-${p}`}
                  >
                    <ErrorRow
                      testid={`cm-error-${primary}-${p}`}
                      message={apiErrorMessage(err)}
                    />
                  </TableCard>
                );
              }
              const resp = respFor(primary, p);
              const dbs = methodDbsFor(primary);
              // Build (scoring variant label → cell %) for present variants,
              // ordered by SCORING_VARIANT_ORDER (workspace.py:1601-1603).
              const variantPct = new Map<string, number | null>();
              for (const db of dbs) {
                const variant = SCORING_VARIANT_MAP[db];
                if (!variant) continue;
                variantPct.set(variant, cellPercent(rowsForPair(resp, db, p)));
              }
              const variantsPresent = SCORING_VARIANT_ORDER.filter((v) =>
                variantPct.has(v),
              );
              return (
                <TableCard
                  key={p}
                  header={pertLabel}
                  testid={`cm-card-${primary}-${p}`}
                >
                  <table
                    className="w-full border-collapse text-sm"
                    data-testid={`cm-table-${primary}-${p}`}
                  >
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-2.5 py-1.5 text-left">Scoring Variant</th>
                        <th className="px-2.5 py-1.5 text-right">
                          Median % Responsive
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {variantsPresent.map((variant) => {
                        const pct = variantPct.get(variant) ?? null;
                        const color = SCORING_VARIANT_COLORS[variant] ?? "#888888";
                        return (
                          <tr
                            key={variant}
                            data-testid={`cm-row-${primary}-${p}-${variant}`}
                          >
                            <td className="whitespace-nowrap px-2.5 py-1.5 text-left">
                              <span
                                className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle"
                                style={{ backgroundColor: color }}
                              />
                              {variant}
                            </td>
                            <Cell pct={pct} />
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableCard>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ===========================================================================
// Shared table primitives
// ===========================================================================

function Cell({ pct, testid }: { pct: number | null; testid?: string }) {
  const style =
    pct === null ? undefined : { backgroundColor: cellGreenBg(pct) };
  return (
    <td
      className="px-2.5 py-1.5 text-right font-mono"
      style={style}
      data-testid={testid}
    >
      {formatCell(pct)}
    </td>
  );
}

function TableCard({
  header,
  children,
  testid,
}: {
  header: string;
  children: React.ReactNode;
  testid?: string;
}) {
  return (
    <div
      className="flex-1 overflow-hidden rounded border border-slate-200"
      style={{ minWidth: 280 }}
      data-testid={testid}
    >
      <div className="border-b border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm font-semibold">
        {header}
      </div>
      {children}
    </div>
  );
}

function LoadingRow({ testid }: { testid?: string }) {
  return (
    <div className="px-2.5 py-3 text-sm text-slate-500" data-testid={testid}>
      Computing…
    </div>
  );
}

// Surfaces a failed per-perturbation slice's backend message (e.g. the 12-pair
// cap 400) in place of the table, so the user never sees a silent all-"—" card
// that is indistinguishable from "computed, no responsive targets". Mirrors the
// route-level `text-red-600` error display (Comparison.tsx:246).
function ErrorRow({ testid, message }: { testid?: string; message: string }) {
  return (
    <div
      className="px-2.5 py-3 text-sm text-red-600"
      data-testid={testid}
      role="alert"
    >
      {message}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-600"
      data-testid="comparison-variant-empty"
    >
      {children}
    </div>
  );
}
