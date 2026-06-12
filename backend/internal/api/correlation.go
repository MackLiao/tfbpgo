package api

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/queries"
)

// Closed enum sets for the `method` and `col` query params. Anything outside
// these sets is a 400 — the values feed into SQL template selection
// (corr_pair_pearson.sql vs corr_pair_spearman.sql) and into the
// effect-vs-pvalue branch on s.Whitelist.Dataset(name). A fuzzed value
// reaching SQL would either pick the wrong template (silently wrong result)
// or get reflected into the canonical cache key (cache fragmentation).
var validCorrMethods = map[string]struct{}{
	"pearson":  {},
	"spearman": {},
}

var validCorrCols = map[string]struct{}{
	"effect":    {},
	"pvalue":    {},
	"log10pval": {},
}

func validateCorrMethod(method string) error {
	if method == "" {
		return fmt.Errorf("method required (pearson|spearman)")
	}
	if _, ok := validCorrMethods[method]; !ok {
		return fmt.Errorf("method: unknown value %q (want pearson|spearman)", method)
	}
	return nil
}

func validateCorrCol(col string) error {
	if col == "" {
		return fmt.Errorf("col required (effect|pvalue|log10pval)")
	}
	if _, ok := validCorrCols[col]; !ok {
		return fmt.Errorf("col: unknown value %q (want effect|pvalue|log10pval)", col)
	}
	return nil
}

// resolveMeasurementCol picks the dataset's effect_col, pvalue_col, or the
// most-direct -log10(p) source column from the manifest. Mirrors Shiny's
// get_measurement_column (reference/tfbpshiny/modules/binding/queries.py:26-56):
//
//	effect    -> effect_col
//	pvalue    -> pvalue_col or effect_col
//	log10pval -> neglog10p_col or log10p_col or pvalue_col or effect_col
//
// When the caller asks for `col=pvalue` but the dataset has no pvalue_col
// (e.g. hackett), fall back to the effect_col. The Python app uses the same
// or-chain for the same reason — many downstream charts treat the fallback as
// "no p-value available, show effect-only" rather than a hard error.
//
// For log10pval the CORRELATION uses this resolved column DIRECTLY (Pearson
// corr is sign-flip invariant, so corr on log_poisson_pval == corr on
// -log_poisson_pval; Spearman is monotone-invariant, so ranking by
// log_poisson_pval == ranking by poisson_pval). The -log10 display transform
// is applied only to the SCATTER points (applyLog10PTransform) — never to the
// correlation inputs. See reference workspace.py:1169-1190.
func resolveMeasurementCol(row db.DatasetRow, col string) (string, error) {
	switch col {
	case "effect":
		if row.EffectCol == "" {
			return "", fmt.Errorf("no effect_col in manifest for dataset %q", row.DBName)
		}
		return row.EffectCol, nil
	case "pvalue":
		if row.PValueCol != "" {
			return row.PValueCol, nil
		}
		if row.EffectCol == "" {
			return "", fmt.Errorf("no effect_col fallback in manifest for dataset %q", row.DBName)
		}
		return row.EffectCol, nil
	case "log10pval":
		// neglog10p_col > log10p_col > pvalue_col > effect_col (first non-empty).
		// No dataset currently ships a neglog10p_col, but the chain is kept in
		// lockstep with the reference so a future artifact that pre-computes one
		// resolves without a code change.
		if row.NegLog10PCol != "" {
			return row.NegLog10PCol, nil
		}
		if row.Log10PCol != "" {
			return row.Log10PCol, nil
		}
		if row.PValueCol != "" {
			return row.PValueCol, nil
		}
		if row.EffectCol == "" {
			return "", fmt.Errorf("no effect_col fallback in manifest for dataset %q", row.DBName)
		}
		return row.EffectCol, nil
	default:
		return "", fmt.Errorf("col: unknown value %q", col)
	}
}

// isPValueCol mirrors Shiny's `is_pvalue = "pval" in col.lower()` heuristic
// in _corr_pair_sql_impl / regulator_scatter_sql. The Spearman SQL templates
// take their ORDER BY direction from this branch:
//
//	effect cols  -> ABS(val_x) DESC   (largest magnitude wins)
//	p-value cols -> val_x ASC         (smallest p-value wins)
//
// Anything matching /pval/i is treated as a p-value. The column names that
// actually flow through this path are all in dataset_manifest.{effect_col,
// pvalue_col,log10p_col,neglog10p_col} and already SafeIdentRE-validated; no
// SQL-injection vector.
//
// log10pval edge cases (Spearman direction parity, ranks are monotone-invariant):
//   - log10p_col   = log_poisson_pval = log10(p) — name contains "pval" → ASC.
//     log10(p) is monotone-increasing in p, so smaller log10(p) = smaller p =
//     more significant = higher rank — correct (== ranking by poisson_pval ASC).
//   - neglog10p_col = -log10(p) — name does NOT contain "pval" → treated as an
//     "effect" col → ABS(val) DESC. -log10(p) is monotone-DEcreasing in p, so
//     larger -log10(p) = smaller p = more significant = higher rank — also
//     correct. No dataset currently ships a neglog10p_col, but the heuristic is
//     directionally right for both source types if one appears.
func isPValueCol(col string) bool {
	return strings.Contains(strings.ToLower(col), "pval")
}

// orderExpr returns the Spearman ORDER BY expression for the given column.
// The returned string is a literal SQL fragment (no user data) — see the
// SQL templates: only "ABS(val_a) DESC" / "val_a ASC" / "ABS(val_b) DESC" /
// "val_b ASC" are valid forms.
func orderExpr(side, col string) string {
	// side is "a" or "b".
	if isPValueCol(col) {
		return fmt.Sprintf("val_%s ASC", side)
	}
	return fmt.Sprintf("ABS(val_%s) DESC", side)
}

// log10pFloor is the lower clamp applied to a raw p-value before -log10 — a
// p of 0 would otherwise map to +Inf. -log10(1e-10) = 10 is the resulting
// upper cap on the transformed value. Mirrors LOG10P_FLOOR in
// reference/tfbpshiny/modules/binding/queries.py:23.
const log10pFloor = 1e-10

// log10pCap is the upper cap on the displayed -log10(p) value. Derived from the
// floor (= -log10(floor) = 10) rather than hardcoded, so the two can never
// drift apart if the floor is ever retuned. Mirrors the reference
// `cap = -np.log10(LOG10P_FLOOR)` (workspace.py:521).
var log10pCap = -math.Log10(log10pFloor)

// log10pSource classifies how a dataset's resolved log10pval column relates to
// the -log10(p) value the scatter wants to display. Mirrors get_log10p_source
// in reference/tfbpshiny/modules/binding/queries.py:59-89.
type log10pSource int

const (
	// srcNone: no p-value variant exists; -log10(p) is unavailable → no transform.
	srcNone log10pSource = iota
	// srcNegLog10P: column is already -log10(p) → apply the upper cap only.
	srcNegLog10P
	// srcLog10P: column is log10(p) → negate, then cap.
	srcLog10P
	// srcPval: column is the raw p-value → -log10(clip(p, floor)) (capped at 10).
	srcPval
)

// log10pSourceFor returns the transform source for one dataset, from its
// manifest columns — neglog10p > log10p > pvalue > none. Independent per side:
// db_a and db_b may resolve differently. Mirrors get_log10p_source
// (reference/.../binding/queries.py:59-89), which keys on the same precedence.
func log10pSourceFor(row db.DatasetRow) log10pSource {
	switch {
	case row.NegLog10PCol != "":
		return srcNegLog10P
	case row.Log10PCol != "":
		return srcLog10P
	case row.PValueCol != "":
		return srcPval
	default:
		return srcNone
	}
}

// log10pAxisLabel is the measure part of the scatter axis label for one side —
// the text the frontend prepends with "{displayName}: ". Mirrors
// _apply_log10p_transform's label (reference workspace.py:523-534) and the
// Spearman/else branches at :1182-1188:
//
//	col=log10pval, method != spearman, source != none  -> "-log10(p)"
//	col=log10pval, method != spearman, source == none   -> the resolved column
//	col=log10pval, method == spearman                   -> "rank by p-value"
//	otherwise                                           -> the resolved column
//
// resolvedCol is the resolved measurement column for THIS side (colA or colB),
// so the effect-fallback side (e.g. hackett, source=none) keeps showing its
// column name while a pval-source side shows "-log10(p)".
func log10pAxisLabel(reqCol, method, resolvedCol string, src log10pSource) string {
	if reqCol != "log10pval" {
		return resolvedCol
	}
	if method == "spearman" {
		return "rank by p-value"
	}
	if src == srcNone {
		return resolvedCol
	}
	return "-log10(p)"
}

// applyLog10PTransform maps one scanned scatter value to its -log10(p) display
// value for the given source. Mirrors _apply_log10p_transform
// (reference/tfbpshiny/modules/binding/server/workspace.py:504-535):
//
//	neglog10p: value already = -log10(p)  -> min(value, cap)
//	log10p:    value = log10(p)           -> min(-value, cap)
//	pval:      value = raw p              -> -log10(max(p, floor))  (== capped at cap)
//	none:      no transform (value passes through unchanged)
//
// NaN/±Inf pass through to preserve the B-1 "plot gap, not a 500" contract:
// a non-finite input stays non-finite (serialized as JSON null by SafeFloat)
// rather than being silently coerced. Note np.clip on NaN returns NaN, and
// -log10(NaN)=NaN / -log10(+Inf)=-Inf, matching pandas/numpy here.
func applyLog10PTransform(v float64, src log10pSource) float64 {
	switch src {
	case srcNegLog10P:
		return math.Min(v, log10pCap)
	case srcLog10P:
		return math.Min(-v, log10pCap)
	case srcPval:
		p := v
		if p < log10pFloor {
			// clip(lower=floor): only finite values below the floor are raised.
			// NaN comparisons are false, so NaN is left untouched (passes through).
			p = log10pFloor
		}
		return -math.Log10(p)
	default: // srcNone
		return v
	}
}

// transformScatterPoints applies the -log10(p) display transform IN PLACE to
// every point's ValA/ValB, using each SIDE's independent source. Caller must
// only invoke this for col=log10pval AND method != spearman — Spearman scatter
// values are RANK() integers, to which the transform does not apply (the
// reference branches on the same condition: workspace.py:1175-1185).
//
// This is applied server-side (not client-side) so the frontend just plots the
// returned numbers and the scatter's `r` — which the reference computes on the
// transformed series (workspace.py:1190 `r = val_a.corr(val_b)` after the
// transform) — is parity-correct when pearsonR runs over these points.
func transformScatterPoints(points []domain.ScatterPoint, srcA, srcB log10pSource) {
	for i := range points {
		points[i].ValA = domain.SafeFloat(applyLog10PTransform(float64(points[i].ValA), srcA))
		points[i].ValB = domain.SafeFloat(applyLog10PTransform(float64(points[i].ValB), srcB))
	}
}

// pairSpec carries the rendered SQL identifiers for one (dbA, dbB) pair.
type pairSpec struct {
	dbA, dbB     string
	colA, colB   string
	extraWhereA  string
	extraWhereB  string
	argsA, argsB []any
}

// renderCorrPairSQL fills the corr_pair_{method}.sql template for one pair.
// method must already be validated (validateCorrMethod). dataType is "binding"
// or "perturbation"; the function picks the right template directory.
//
// The returned args slice is the concatenation of pair.argsA and pair.argsB
// — corr_pair templates have no positional `?` placeholders other than what
// the filter clauses contribute, and DuckDB binds positionally left-to-right.
func renderCorrPairSQL(method, dataType string, pair pairSpec) (string, []any) {
	tmpl := queries.Get(dataType + "/corr_pair_" + method + ".sql")
	repls := []string{
		// Identifier placeholders are double-quoted (quotedIdent) so a
		// reserved-keyword table/column parses; the *_literal placeholders
		// below are NOT — they substitute into single-quoted string literals.
		"{{table_a}}", quotedIdent(pair.dbA),
		"{{table_b}}", quotedIdent(pair.dbB),
		"{{col_a}}", quotedIdent(pair.colA),
		"{{col_b}}", quotedIdent(pair.colB),
		// db_*_literal substitutes into a single-quoted string literal in the
		// template (e.g. '{{db_a_literal}}' AS db_a). The values are already
		// SafeIdentRE-validated dataset db_names, which the SafeIdentRE
		// pattern restricts to `[A-Za-z0-9_]+` — no apostrophes, no quote-
		// escape needed.
		"{{db_a_literal}}", whitelistedIdent(pair.dbA),
		"{{db_b_literal}}", whitelistedIdent(pair.dbB),
		"{{extra_where_a}}", pair.extraWhereA,
		"{{extra_where_b}}", pair.extraWhereB,
	}
	if method == "spearman" {
		repls = append(repls,
			"{{order_a_expr}}", orderExpr("a", pair.colA),
			"{{order_b_expr}}", orderExpr("b", pair.colB),
		)
	}
	sqlStr := strings.NewReplacer(repls...).Replace(tmpl)
	args := make([]any, 0, len(pair.argsA)+len(pair.argsB))
	args = append(args, pair.argsA...)
	args = append(args, pair.argsB...)
	return sqlStr, args
}

// renderCorrUnionAllSQL renders ONE UNION-ALL query covering every pair in
// `pairs`. Each inner per-pair SQL is wrapped as:
//
//	SELECT *, '{db_a}__{db_b}' AS pair_key FROM ( <renderCorrPairSQL> )
//
// and the segments are joined with `UNION ALL`. The returned args slice is
// the concatenation of each pair's args, in the same order as `pairs` — this
// matches DuckDB's positional `?` binding (left-to-right across the whole
// statement).
//
// The `pair_key` literal is built from the dataset db_names, which are
// already SafeIdentRE-validated ([A-Za-z0-9_]+) via the dataset_manifest
// whitelist, so the embedded string is apostrophe-free and needs no
// quote-escaping. This mirrors the existing `{{db_a_literal}}` substitution
// in the per-pair template.
//
// Mirrors Shiny's corr_all_pairs_sql shape (one UNION-ALL roundtrip across
// itertools.combinations(sorted(datasets), 2)) — see
// reference/tfbpshiny/modules/binding/queries.py:331-390. With MaxOpenConns=2
// on t3.small and N=4 datasets (6 pairs), this turns 6 sequential
// SelectContext calls into 1.
func renderCorrUnionAllSQL(method, dataType string, pairs []pairSpec) (string, []any) {
	segments := make([]string, 0, len(pairs))
	args := make([]any, 0, len(pairs)*2)
	for _, p := range pairs {
		inner, innerArgs := renderCorrPairSQL(method, dataType, p)
		// pair_key uses the dbA/dbB identifiers verbatim — both are
		// whitelistedIdent-validated upstream (callers pass values that
		// passed CheckDataset → SafeIdentRE), so no escaping is required.
		key := whitelistedIdent(p.dbA) + "__" + whitelistedIdent(p.dbB)
		segments = append(segments, "SELECT *, '"+key+"' AS pair_key FROM (\n"+inner+"\n)")
		args = append(args, innerArgs...)
	}
	unionSQL := strings.Join(segments, "\nUNION ALL\n")
	// Deterministic total order over the assembled UNION → reproducible cache
	// bytes and stable within-pair ordering when buildCorrResponse partitions by
	// pair_key. pair_key discriminates per-pair blocks; (regulator, db_a_id,
	// db_b_id) is each pair's unique GROUP BY key.
	unionSQL += "\nORDER BY pair_key, regulator_locus_tag, db_a_id, db_b_id"
	return unionSQL, args
}

// renderScatterSQL fills the regulator_scatter_{method}.sql template. The
// regulator binds positionally TWICE (once per inner subquery) — the
// returned args slice is therefore: [regulator, argsA..., regulator, argsB...].
// This matches the template layout:
//
//	WHERE regulator_locus_tag = ? {{extra_where_a}}
//	...
//	WHERE regulator_locus_tag = ? {{extra_where_b}}
//
// Callers MUST have already stripped `regulator_locus_tag` from the filter
// dict before building extraWhere* — otherwise the inner subquery would
// have `WHERE regulator = ? AND regulator IN (...)`. See
// stripRegulatorFilter and reference/tfbpshiny/modules/binding/server/
// workspace.py:536-540.
func renderScatterSQL(method, dataType, regulator string, pair pairSpec) (string, []any) {
	tmpl := queries.Get(dataType + "/regulator_scatter_" + method + ".sql")
	repls := []string{
		"{{table_a}}", quotedIdent(pair.dbA),
		"{{table_b}}", quotedIdent(pair.dbB),
		"{{col_a}}", quotedIdent(pair.colA),
		"{{col_b}}", quotedIdent(pair.colB),
		"{{extra_where_a}}", pair.extraWhereA,
		"{{extra_where_b}}", pair.extraWhereB,
	}
	if method == "spearman" {
		repls = append(repls,
			"{{order_a_expr}}", orderExpr("a", pair.colA),
			"{{order_b_expr}}", orderExpr("b", pair.colB),
		)
	}
	sqlStr := strings.NewReplacer(repls...).Replace(tmpl)
	args := make([]any, 0, 2+len(pair.argsA)+len(pair.argsB))
	args = append(args, regulator)
	args = append(args, pair.argsA...)
	args = append(args, regulator)
	args = append(args, pair.argsB...)
	return sqlStr, args
}

// stripRegulatorFilter returns a shallow copy of fs with the
// "regulator_locus_tag" key removed. Returns the same map (nil-safe) when
// the key is absent so callers don't pay an allocation for the common
// case. Mirrors Shiny's
//
//	pop_keys = {f for f in filters[db] if f == "regulator_locus_tag"}
//	for k in pop_keys: filters[db].pop(k)
//
// in reference/tfbpshiny/modules/binding/server/workspace.py:536-540. The
// scatter SQL templates bind the regulator as a positional `?` so the
// extra IN-list would otherwise produce a redundant (and potentially
// contradictory) WHERE clause.
// regulatorLocusTagField is the hidden-but-valid WHERE field the
// common-regulators flow ("Select N common regulators") writes to every active
// dataset. It is intentionally ABSENT from field_manifest (hidden from the
// filter UI), but it IS a real {db}_meta column and a legitimate WHERE target
// in Shiny (reference/.../select_datasets/queries.py:45-48). Two handler
// families treat it differently, matching Shiny:
//   - correlation handlers STRIP it (stripRegulatorFilter) — they resolve
//     regulators via the shared-regulator INTERSECT, so an extra IN-list WHERE
//     would be redundant/contradictory (workspace.py:536-540).
//   - matrix / breakdown / export handlers ACCEPT and APPLY it (checkFilterFields
//     skips the whitelist for it) so the matrix narrows to the chosen regulators
//     (workspace.py:90-123 passes dataset_filters() straight into the queries).
const regulatorLocusTagField = "regulator_locus_tag"

func stripRegulatorFilter(fs map[string]domain.FilterSpec) map[string]domain.FilterSpec {
	if fs == nil {
		return nil
	}
	if _, ok := fs[regulatorLocusTagField]; !ok {
		return fs
	}
	out := make(map[string]domain.FilterSpec, len(fs)-1)
	for k, v := range fs {
		if k == regulatorLocusTagField {
			continue
		}
		out[k] = v
	}
	return out
}

// checkFilterFields validates every (db, field) in `filters` against the
// manifest whitelist, EXCEPT regulatorLocusTagField, which is accepted as a
// hidden-but-valid {db}_meta WHERE column (P0-2). The field is matched against
// a compile-time constant — no other un-whitelisted field can slip through —
// and buildSquirrelWhere double-quotes the identifier + parameterizes values,
// so accepting this one constant is injection-safe. Returns the first rejection.
func (s *Server) checkFilterFields(filters domain.FiltersByDB) error {
	for dbName, fs := range filters {
		for fld := range fs {
			if fld == regulatorLocusTagField {
				continue
			}
			if err := s.Whitelist.CheckField(dbName, fld); err != nil {
				return err
			}
		}
	}
	return nil
}

// pearsonR computes the Pearson correlation coefficient over a slice of
// (x, y) pairs, mirroring pandas Series.corr() (Shiny's
// r=merged["_val_a"].corr(merged["_val_b"]), workspace.py:569):
//
//   - Pairs where EITHER value is NaN (a SQL NULL scanned to NaN) are dropped
//     pairwise — pandas excludes incomplete rows.
//   - If a surviving pair carries ±Inf, the result is NaN — pandas does NOT
//     drop inf; it flows into the moments and yields nan. (B-1 inf-parity.)
//   - For the Spearman variants the inputs are already RANK() integers, so
//     this is Pearson-on-ranks = the Spearman coefficient.
//
// Returns 0 for fewer than two finite pairs or a zero-variance series (the
// degenerate r=0 vs Shiny's r=nan difference is the cosmetic B-4 item, left
// as-is). The caller wraps the result in domain.SafeFloat, so a NaN return
// (inf present) serializes as JSON null.
//
// Numerical note: the naive sum-of-squares formula is sensitive to
// catastrophic cancellation when |mean| >> stddev. For the row counts served
// here (per-regulator scatter, max ~few thousand points) the error is well
// below the precision the UI displays. Swap to Welford/two-pass if needed.
func pearsonR(points []domain.ScatterPoint) float64 {
	xs := make([]float64, 0, len(points))
	ys := make([]float64, 0, len(points))
	for _, p := range points {
		a, b := float64(p.ValA), float64(p.ValB)
		if math.IsNaN(a) || math.IsNaN(b) {
			continue // pandas drops incomplete pairs (NaN/NULL)
		}
		if math.IsInf(a, 0) || math.IsInf(b, 0) {
			return math.NaN() // pandas propagates inf -> nan
		}
		xs = append(xs, a)
		ys = append(ys, b)
	}
	n := float64(len(xs))
	if n < 2 {
		return 0
	}
	var sx, sy, sxy, sx2, sy2 float64
	for i := range xs {
		x, y := xs[i], ys[i]
		sx += x
		sy += y
		sxy += x * y
		sx2 += x * x
		sy2 += y * y
	}
	num := sxy - sx*sy/n
	denomA := sx2 - sx*sx/n
	denomB := sy2 - sy*sy/n
	// Clamp denomA/denomB to >=0 before sqrt: with floating-point round-off
	// near zero-variance series these can land at e.g. -2.7e-17, which would
	// produce NaN under math.Sqrt. The downstream IsNaN/IsInf guards remain
	// as defense-in-depth, but the clamp eliminates the only NaN path
	// reachable from finite finite-variance inputs.
	if denomA < 0 {
		denomA = 0
	}
	if denomB < 0 {
		denomB = 0
	}
	denom := math.Sqrt(denomA * denomB)
	if denom == 0 || math.IsNaN(denom) || math.IsInf(denom, 0) {
		return 0
	}
	r := num / denom
	if math.IsNaN(r) || math.IsInf(r, 0) {
		return 0
	}
	// Clamp to [-1, 1]: DuckDB's corr() has been observed returning
	// 1.0000000000000004 on perfectly-correlated inputs; this Go path
	// is independent but uses the same algorithm class. Clamping
	// guarantees JSON consumers never see |r| > 1.
	if r > 1 {
		return 1
	}
	if r < -1 {
		return -1
	}
	return r
}

// sortedPairs returns sorted(datasets) choose 2 in stable (i < j) order.
// Mirrors itertools.combinations(sorted(datasets), 2). The deterministic
// ordering is what makes the cache key stable across (datasets=A,B) vs
// (datasets=B,A) request orderings: canonValues already sorts the input
// CSV before hashing, and this function produces the SAME pair sequence
// regardless of input order.
func sortedPairs(datasets []string) [][2]string {
	sorted := make([]string, len(datasets))
	copy(sorted, datasets)
	// Sort ascending for determinism. Inputs from the canonValues path are
	// dedupeAndCapCSV outputs (first-seen order); sorting here makes the
	// pair sequence — and therefore the resulting JSON body and cache key —
	// independent of caller-side ordering.
	sort.Strings(sorted)
	pairs := make([][2]string, 0, len(sorted)*(len(sorted)-1)/2)
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			pairs = append(pairs, [2]string{sorted[i], sorted[j]})
		}
	}
	return pairs
}
