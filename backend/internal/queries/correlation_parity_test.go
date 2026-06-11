package queries

// Numerical-parity tests for the eight correlation SQL templates (binding +
// perturbation × pearson + spearman × corr_pair + regulator_scatter) added
// in Task A2. These exercise each template against the committed read-only
// fixture (tests/fixtures/tfbp_test.duckdb, built by data_prep/build_fixture.py)
// and assert the row counts + at least one exact correlation value derived
// from the linspace data layout documented in build_fixture.py.

import (
	"context"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	_ "github.com/marcboeker/go-duckdb/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// envDuckThreads lets `DUCKDB_THREADS=2 go test ./internal/queries/` run the
// numerical-parity suite at the same thread count a resized box uses, so the
// threads>1 deviation is validated against the recorded single-thread
// expectations. 0 → db.Open defaults to 1. NOTE: the fixture is small, so
// DuckDB may not actually parallelize it — the definitive threads=2 parity
// check is a real-artifact threads=1-vs-2 output diff (see deploy verification).
func envDuckThreads() int {
	n, _ := strconv.Atoi(os.Getenv("DUCKDB_THREADS"))
	return n
}

const (
	ccTable    = "callingcards"
	ccEffect   = "callingcards_enrichment"
	ccPvalue   = "poisson_pval"
	hTable     = "hackett"
	hEffect    = "log2_shrunken_timecourses"
	regYBR289W = "YBR289W"
)

// fixturePoolForTest copies the read-only fixture to a tmp file (so DuckDB
// can lock it) and opens it via db.Open with the §6.3 settings.
func fixturePoolForTest(t *testing.T) *db.Pool {
	t.Helper()
	srcPath, err := filepath.Abs("../../../tests/fixtures/tfbp_test.duckdb")
	require.NoError(t, err)
	dstPath := filepath.Join(t.TempDir(), "fixture.duckdb")
	src, err := os.Open(srcPath)
	require.NoError(t, err)
	defer src.Close()
	dst, err := os.Create(dstPath)
	require.NoError(t, err)
	_, err = io.Copy(dst, src)
	require.NoError(t, err)
	require.NoError(t, dst.Close())

	pool, err := db.Open(db.Options{Path: dstPath, TempDir: t.TempDir(), Threads: envDuckThreads()})
	require.NoError(t, err)
	t.Cleanup(func() { _ = pool.Close() })
	return pool
}

// renderCorrPair fills in the corr_pair_* template placeholders. extraWhere*
// must be empty or a string that starts with " AND " (mirroring the data.sql
// convention).
func renderCorrPair(tmpl, tableA, colA, tableB, colB, dbALit, dbBLit,
	extraWhereA, extraWhereB, orderA, orderB string) string {
	return strings.NewReplacer(
		"{{table_a}}", tableA,
		"{{table_b}}", tableB,
		"{{col_a}}", colA,
		"{{col_b}}", colB,
		"{{db_a_literal}}", dbALit,
		"{{db_b_literal}}", dbBLit,
		"{{extra_where_a}}", extraWhereA,
		"{{extra_where_b}}", extraWhereB,
		"{{order_a_expr}}", orderA,
		"{{order_b_expr}}", orderB,
	).Replace(tmpl)
}

func renderScatter(tmpl, tableA, colA, tableB, colB,
	extraWhereA, extraWhereB, orderA, orderB string) string {
	return strings.NewReplacer(
		"{{table_a}}", tableA,
		"{{table_b}}", tableB,
		"{{col_a}}", colA,
		"{{col_b}}", colB,
		"{{extra_where_a}}", extraWhereA,
		"{{extra_where_b}}", extraWhereB,
		"{{order_a_expr}}", orderA,
		"{{order_b_expr}}", orderB,
	).Replace(tmpl)
}

// ----------------------------------------------------------------------
// Derivation of expected exact correlation values from build_fixture.py:
//
// callingcards (30 rows, three regulators × two sample suffixes × five
// targets, in that order):
//   row_index = (reg_idx * 2 + sample_suffix_idx) * 5 + target_idx
//   callingcards_enrichment = linspace(0.1, 5.0, 30)[row_index]
//     step = (5.0 - 0.1) / 29 = 0.16896551724137932
//
// hackett (15 rows, three regulators × one sample × five targets):
//   row_index = reg_idx * 5 + target_idx
//   log2_shrunken_timecourses = linspace(-3.0, 3.0, 15)[row_index]
//     step = 6.0 / 14 = 0.42857142857142855
//
// For the group (regulator=YBR289W, cc_sample='cc_0_a', h_sample='h_0'):
//   cc rows: target_idx in 0..4 → enrichment values v_cc[i] = 0.1 + i*step_cc
//   h  rows: target_idx in 0..4 → log2 values         v_h [i] = -3.0 + i*step_h
//   Both are strictly increasing arithmetic progressions over the same
//   target ordering, so the Pearson correlation is exactly +1.0.
//
// For Spearman on the same group (ABS(val) DESC ordering since both are
// effect columns):
//   cc values are all positive and increasing → ABS DESC rank for target_idx
//     i is (5 - i)  → ranks = [5, 4, 3, 2, 1]
//   h values are all negative in this regulator's window
//     (-3.0, -2.57…, -2.14…, -1.71…, -1.28…) → ABS DESC rank for target_idx
//     i is (i + 1)  → ranks = [1, 2, 3, 4, 5]
//   Pearson on ([5,4,3,2,1], [1,2,3,4,5]) = -1.0.
// ----------------------------------------------------------------------

type corrPairRow struct {
	DBA         string  `db:"db_a"`
	DBAID       string  `db:"db_a_id"`
	DBB         string  `db:"db_b"`
	DBBID       string  `db:"db_b_id"`
	Regulator   string  `db:"regulator_locus_tag"`
	Correlation float64 `db:"correlation"`
}

func selectRows(t *testing.T, pool *db.Pool, sqlStr string, args ...any) []corrPairRow {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var rows []corrPairRow
	require.NoError(t, pool.DB.SelectContext(ctx, &rows, sqlStr, args...))
	return rows
}

func TestCorrPair_Pearson_BindingTemplate(t *testing.T) {
	pool := fixturePoolForTest(t)

	tmpl := Get("binding/corr_pair_pearson.sql")
	sqlStr := renderCorrPair(
		tmpl,
		ccTable, ccEffect, hTable, hEffect,
		"callingcards", "hackett",
		"", "",
		"", "", // order exprs unused for pearson
	)
	rows := selectRows(t, pool, sqlStr)

	// 3 regulators × 2 cc sample suffixes × 1 hackett sample = 6 groups, each
	// with 5 paired targets ≥ the HAVING COUNT(*) >= 3 floor.
	require.Len(t, rows, 6, "expected 6 (regulator × cc_sample × h_sample) groups")

	regs := map[string]bool{}
	samplesA := map[string]bool{}
	samplesB := map[string]bool{}
	for _, r := range rows {
		assert.Equal(t, "callingcards", r.DBA)
		assert.Equal(t, "hackett", r.DBB)
		assert.False(t, math.IsNaN(r.Correlation), "correlation should not be NaN for %+v", r)
		assert.False(t, math.IsInf(r.Correlation, 0), "correlation should be finite for %+v", r)
		// DuckDB corr() returns values that may exceed |1| by 1-2 ULPs
		// (here 1.0000000000000004 has been observed) on perfectly
		// correlated inputs; allow a small slop.
		assert.GreaterOrEqual(t, r.Correlation, -1.0-1e-9)
		assert.LessOrEqual(t, r.Correlation, 1.0+1e-9)
		regs[r.Regulator] = true
		samplesA[r.DBAID] = true
		samplesB[r.DBBID] = true
	}
	assert.Len(t, regs, 3, "expected 3 distinct regulators")
	// cc has 3 regulators × 2 suffixes = 6 distinct sample_ids.
	assert.Len(t, samplesA, 6, "expected 6 distinct callingcards sample_ids")
	assert.Len(t, samplesB, 3, "expected 3 distinct hackett sample_ids (one per regulator)")

	// Exact-value spot check for (YBR289W, cc_0_a, h_0) — see derivation above.
	// Both sides are perfectly linearly increasing over the 5 shared targets,
	// so Pearson correlation = +1.0 exactly.
	for _, r := range rows {
		if r.Regulator == regYBR289W && r.DBAID == "cc_0_a" && r.DBBID == "h_0" {
			assert.InDelta(t, 1.0, r.Correlation, 1e-9,
				"expected perfectly correlated linspace pair to give corr=1.0")
			return
		}
	}
	t.Fatalf("did not find expected group (YBR289W, cc_0_a, h_0)")
}

func TestCorrPair_Spearman_BindingTemplate(t *testing.T) {
	pool := fixturePoolForTest(t)

	tmpl := Get("binding/corr_pair_spearman.sql")
	// Both columns are effect columns → ABS(val) DESC.
	sqlStr := renderCorrPair(
		tmpl,
		ccTable, ccEffect, hTable, hEffect,
		"callingcards", "hackett",
		"", "",
		"ABS(val_a) DESC", "ABS(val_b) DESC",
	)
	rows := selectRows(t, pool, sqlStr)

	require.Len(t, rows, 6)
	for _, r := range rows {
		assert.False(t, math.IsNaN(r.Correlation))
		assert.GreaterOrEqual(t, r.Correlation, -1.0-1e-9)
		assert.LessOrEqual(t, r.Correlation, 1.0+1e-9)
	}

	// Exact-value spot check (see derivation above): for (YBR289W, cc_0_a, h_0)
	// cc ABS DESC ranks = [5,4,3,2,1]; h ABS DESC ranks = [1,2,3,4,5];
	// Pearson on those = -1.0.
	for _, r := range rows {
		if r.Regulator == regYBR289W && r.DBAID == "cc_0_a" && r.DBBID == "h_0" {
			assert.InDelta(t, -1.0, r.Correlation, 1e-9,
				"expected anti-correlated ranks (cc positive ↑ vs h negative ↑) to give corr=-1.0")
			return
		}
	}
	t.Fatalf("did not find expected group (YBR289W, cc_0_a, h_0)")
}

// The perturbation/corr_pair_*.sql templates are byte-identical in shape to
// the binding ones (the Shiny shared _corr_pair_sql_impl produces the same
// SQL for either side; the only difference is which data_query_fn supplies
// the per-dataset sub-SELECT, which here is just the {{table_*}} / {{col_*}}
// substitution). Running the same hackett × callingcards parameterisation
// through the perturbation templates is sufficient to prove parity for
// Task A3's perturbation correlation endpoint.

func TestCorrPair_Pearson_PerturbationTemplate(t *testing.T) {
	pool := fixturePoolForTest(t)

	tmpl := Get("perturbation/corr_pair_pearson.sql")
	sqlStr := renderCorrPair(
		tmpl,
		hTable, hEffect, ccTable, ccEffect,
		"hackett", "callingcards",
		"", "",
		"", "",
	)
	rows := selectRows(t, pool, sqlStr)

	// hackett A (1 sample/reg) × callingcards B (2 samples/reg) × 3 regs = 6 groups.
	require.Len(t, rows, 6)
	for _, r := range rows {
		assert.Equal(t, "hackett", r.DBA)
		assert.Equal(t, "callingcards", r.DBB)
		assert.False(t, math.IsNaN(r.Correlation))
	}

	// Spot check (YBR289W, h_0, cc_0_a) — same data, sides swapped, so still +1.0.
	for _, r := range rows {
		if r.Regulator == regYBR289W && r.DBAID == "h_0" && r.DBBID == "cc_0_a" {
			assert.InDelta(t, 1.0, r.Correlation, 1e-9)
			return
		}
	}
	t.Fatalf("did not find expected group (YBR289W, h_0, cc_0_a)")
}

func TestCorrPair_Spearman_PerturbationTemplate(t *testing.T) {
	pool := fixturePoolForTest(t)

	tmpl := Get("perturbation/corr_pair_spearman.sql")
	sqlStr := renderCorrPair(
		tmpl,
		hTable, hEffect, ccTable, ccEffect,
		"hackett", "callingcards",
		"", "",
		"ABS(val_a) DESC", "ABS(val_b) DESC",
	)
	rows := selectRows(t, pool, sqlStr)

	require.Len(t, rows, 6)
	for _, r := range rows {
		assert.GreaterOrEqual(t, r.Correlation, -1.0-1e-9)
		assert.LessOrEqual(t, r.Correlation, 1.0+1e-9)
	}
	// Sides swapped vs. binding case: ranks now [1..5] for h and [5..1] for cc → -1.0.
	for _, r := range rows {
		if r.Regulator == regYBR289W && r.DBAID == "h_0" && r.DBBID == "cc_0_a" {
			assert.InDelta(t, -1.0, r.Correlation, 1e-9)
			return
		}
	}
	t.Fatalf("did not find expected group (YBR289W, h_0, cc_0_a)")
}

// Verify the HAVING COUNT(*) >= 3 floor actually fires. We construct a
// degenerate sub-SELECT by filtering callingcards to a single target_locus_tag,
// which leaves at most 2 rows per (reg, cc_sample, h_sample) group — below
// the floor — so the result must be empty.
func TestCorrPair_Pearson_HavingFloorExcludesUnderCount(t *testing.T) {
	pool := fixturePoolForTest(t)

	tmpl := Get("binding/corr_pair_pearson.sql")
	sqlStr := renderCorrPair(
		tmpl,
		ccTable, ccEffect, hTable, hEffect,
		"callingcards", "hackett",
		" AND target_locus_tag = 'YAL001C'",
		"",
		"", "",
	)
	rows := selectRows(t, pool, sqlStr)
	assert.Len(t, rows, 0, "single-target sub-SELECT must be pruned by HAVING COUNT(*) >= 3")
}

// ----------------------------------------------------------------------
// regulator_scatter — per-target (or per-(target,sample_a,sample_b)) pairs
// for a single regulator.
//
// For YBR289W, callingcards × hackett:
//   - callingcards side filtered to YBR289W → 10 rows (2 samples × 5 targets)
//   - hackett side filtered to YBR289W →  5 rows (1 sample × 5 targets)
//   - INNER JOIN on target_locus_tag → 2 × 1 × 5 = 10 rows.
// ----------------------------------------------------------------------

type scatterPearsonRow struct {
	Target string  `db:"target_locus_tag"`
	ValA   float64 `db:"val_a"`
	ValB   float64 `db:"val_b"`
}

type scatterSpearmanRow struct {
	Target string `db:"target_locus_tag"`
	ValA   int64  `db:"val_a"`
	ValB   int64  `db:"val_b"`
}

func TestRegulatorScatter_Pearson_BindingTemplate(t *testing.T) {
	pool := fixturePoolForTest(t)

	tmpl := Get("binding/regulator_scatter_pearson.sql")
	sqlStr := renderScatter(
		tmpl,
		ccTable, ccEffect, hTable, hEffect,
		"", "",
		"", "",
	)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var rows []scatterPearsonRow
	require.NoError(t, pool.DB.SelectContext(ctx, &rows, sqlStr, regYBR289W, regYBR289W))

	// 2 cc rows × 1 hackett row × 5 shared targets = 10 joined rows.
	assert.Len(t, rows, 10)
	seenTargets := map[string]int{}
	for _, r := range rows {
		assert.False(t, math.IsNaN(r.ValA))
		assert.False(t, math.IsNaN(r.ValB))
		assert.False(t, math.IsInf(r.ValA, 0))
		assert.False(t, math.IsInf(r.ValB, 0))
		seenTargets[r.Target]++
	}
	assert.Len(t, seenTargets, 5, "expected 5 distinct targets")
	for tgt, n := range seenTargets {
		assert.Equal(t, 2, n, "target %s should appear twice (one per cc sample)", tgt)
	}
}

func TestRegulatorScatter_Spearman_BindingTemplate(t *testing.T) {
	pool := fixturePoolForTest(t)

	tmpl := Get("binding/regulator_scatter_spearman.sql")
	sqlStr := renderScatter(
		tmpl,
		ccTable, ccEffect, hTable, hEffect,
		"", "",
		"ABS(val_a) DESC", "ABS(val_b) DESC",
	)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var rows []scatterSpearmanRow
	require.NoError(t, pool.DB.SelectContext(ctx, &rows, sqlStr, regYBR289W, regYBR289W))

	require.Len(t, rows, 10)
	const n = int64(10)
	for _, r := range rows {
		// RANK() outputs are dense 1..N (with possible gaps when there are ties).
		assert.GreaterOrEqual(t, r.ValA, int64(1))
		assert.LessOrEqual(t, r.ValA, n)
		assert.GreaterOrEqual(t, r.ValB, int64(1))
		assert.LessOrEqual(t, r.ValB, n)
	}
}

func TestRegulatorScatter_Pearson_PerturbationTemplate(t *testing.T) {
	pool := fixturePoolForTest(t)

	tmpl := Get("perturbation/regulator_scatter_pearson.sql")
	sqlStr := renderScatter(
		tmpl,
		hTable, hEffect, ccTable, ccEffect,
		"", "",
		"", "",
	)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var rows []scatterPearsonRow
	require.NoError(t, pool.DB.SelectContext(ctx, &rows, sqlStr, regYBR289W, regYBR289W))
	// hackett (1 sample) × callingcards (2 samples) × 5 targets = 10 rows.
	assert.Len(t, rows, 10)
}

func TestRegulatorScatter_Spearman_PerturbationTemplate(t *testing.T) {
	pool := fixturePoolForTest(t)

	tmpl := Get("perturbation/regulator_scatter_spearman.sql")
	sqlStr := renderScatter(
		tmpl,
		hTable, hEffect, ccTable, ccEffect,
		"", "",
		"ABS(val_a) DESC", "ABS(val_b) DESC",
	)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var rows []scatterSpearmanRow
	require.NoError(t, pool.DB.SelectContext(ctx, &rows, sqlStr, regYBR289W, regYBR289W))
	require.Len(t, rows, 10)
	const n = int64(10)
	for _, r := range rows {
		assert.GreaterOrEqual(t, r.ValA, int64(1))
		assert.LessOrEqual(t, r.ValA, n)
		assert.GreaterOrEqual(t, r.ValB, int64(1))
		assert.LessOrEqual(t, r.ValB, n)
	}
}

// Sanity: confirm the pvalue ASC ordering also runs end-to-end. The spearman
// templates accept "val_a ASC" / "val_b ASC" as alternate ORDER BY exprs
// (matching Shiny's "is_pvalue" branch); we just verify the SQL parses and
// returns the expected row count.
func TestCorrPair_Spearman_PvalueOrderRuns(t *testing.T) {
	pool := fixturePoolForTest(t)

	tmpl := Get("binding/corr_pair_spearman.sql")
	sqlStr := renderCorrPair(
		tmpl,
		ccTable, ccPvalue, hTable, hEffect,
		"callingcards", "hackett",
		"", "",
		"val_a ASC", "ABS(val_b) DESC",
	)
	rows := selectRows(t, pool, sqlStr)
	assert.Len(t, rows, 6)
}
