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
	"effect": {},
	"pvalue": {},
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
		return fmt.Errorf("col required (effect|pvalue)")
	}
	if _, ok := validCorrCols[col]; !ok {
		return fmt.Errorf("col: unknown value %q (want effect|pvalue)", col)
	}
	return nil
}

// resolveMeasurementCol picks the dataset's effect_col or pvalue_col
// from the manifest. Mirrors Shiny's get_measurement_column behavior:
// when the caller asks for `col=pvalue` but the dataset has no
// pvalue_col (e.g. hackett), fall back to the effect_col. The Python
// app uses .get(col_kind, effect_col) for the same reason — many
// downstream charts treat the fallback as "no p-value available, show
// effect-only" rather than a hard error.
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
// pvalue_col} and already SafeIdentRE-validated; no SQL-injection vector.
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
	return strings.Join(segments, "\nUNION ALL\n"), args
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
func stripRegulatorFilter(fs map[string]domain.FilterSpec) map[string]domain.FilterSpec {
	if fs == nil {
		return nil
	}
	if _, ok := fs["regulator_locus_tag"]; !ok {
		return fs
	}
	out := make(map[string]domain.FilterSpec, len(fs)-1)
	for k, v := range fs {
		if k == "regulator_locus_tag" {
			continue
		}
		out[k] = v
	}
	return out
}

// pearsonR computes the Pearson correlation coefficient over a slice of
// (x, y) pairs using the textbook single-pass formula. Returns 0 when
// fewer than 2 points are supplied or when the denominator is zero
// (zero-variance series). Mirrors Shiny's coercion of NaN -> 0 at the
// JSON layer (pd.Series.corr returns NaN for these inputs, which the
// client cannot render without special-casing).
//
// Numerical note: the naive sum-of-squares formula is sensitive to
// catastrophic cancellation when |mean| >> stddev. For the row counts
// served here (per-regulator scatter, max ~few thousand points) the
// error is well below the precision the UI displays (3-4 sig figs).
// If we ever need stable accumulation, swap to Welford / two-pass.
func pearsonR(points []domain.ScatterPoint) float64 {
	n := float64(len(points))
	if n < 2 {
		return 0
	}
	var sx, sy, sxy, sx2, sy2 float64
	for _, p := range points {
		sx += p.ValA
		sy += p.ValB
		sxy += p.ValA * p.ValB
		sx2 += p.ValA * p.ValA
		sy2 += p.ValB * p.ValB
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
