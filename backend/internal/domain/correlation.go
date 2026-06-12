package domain

// CorrPairPoint is one (regulator, sample_a, sample_b) correlation value
// produced by the corr_pair_{method}.sql template. The shape is identical
// for Pearson and Spearman variants — only the SQL upstream of corr()
// changes (raw values for Pearson, RANK() outputs for Spearman).
type CorrPairPoint struct {
	DBA               string  `json:"dbA" db:"db_a"`
	DBAId             string  `json:"dbAId" db:"db_a_id"`
	DBB               string  `json:"dbB" db:"db_b"`
	DBBId             string  `json:"dbBId" db:"db_b_id"`
	RegulatorLocusTag string  `json:"regulatorLocusTag" db:"regulator_locus_tag"`
	Correlation       float64 `json:"correlation" db:"correlation"`
}

// CorrPairPointWithKey extends CorrPairPoint with a `pair_key` discriminator
// projected by the outer SELECT of the UNION-ALL corr query. The key is the
// "{db_a}__{db_b}" string the Go handler partitions on after the single
// roundtrip executes. Internal to the API package's UNION-ALL consolidation
// (Task C9); not part of the wire shape — it is stripped before JSON
// serialization.
type CorrPairPointWithKey struct {
	CorrPairPoint
	PairKey string `db:"pair_key"`
}

// CorrPair groups CorrPairPoint rows by the (dbA, dbB, colA, colB) tuple
// that produced them. v1 emits one CorrPair per (dbA, dbB) drawn from
// sorted(datasets) choose 2.
type CorrPair struct {
	DBA    string          `json:"dbA"`
	DBB    string          `json:"dbB"`
	ColA   string          `json:"colA"`
	ColB   string          `json:"colB"`
	Points []CorrPairPoint `json:"points"`
}

// CorrResponse is the wire envelope returned by /binding/corr and
// /perturbation/correlations.
//
// RegulatorDisplay (B-2/P-4) maps each regulator_locus_tag appearing in Pairs
// to its "SYMBOL (LOCUS_TAG)" display name (from regulator_display_names),
// mirroring Shiny's sym_map (vdb_init.py:165-180). The frontend uses it to
// label the regulator picker + boxplot hovers and to sort the picker by symbol.
// Regulators absent from regulator_display_names are simply omitted (the
// frontend falls back to the bare locus tag).
type CorrResponse struct {
	Method           string            `json:"method"` // "pearson" | "spearman"
	Col              string            `json:"col"`    // "effect" | "pvalue"
	Pairs            []CorrPair        `json:"pairs"`
	RegulatorDisplay map[string]string `json:"regulatorDisplay"`
}

// ScatterPoint is one (target, val_a, val_b) row produced by the
// regulator_scatter_{method}.sql template. For Pearson, val* are raw numeric
// values; for Spearman, val* are RANK() outputs. val* are SafeFloat: B-1 parity
// removed the SQL finite-value filter (Shiny's scatter path is intentionally
// unfiltered), so a NULL/NaN/±Inf measurement can now reach this row — it
// serializes as JSON `null` (a plot gap) instead of 500-ing the response, and
// scans a SQL NULL via SafeFloat.Scan.
type ScatterPoint struct {
	TargetLocusTag string    `json:"targetLocusTag" db:"target_locus_tag"`
	ValA           SafeFloat `json:"valA" db:"val_a"`
	ValB           SafeFloat `json:"valB" db:"val_b"`
}

// ScatterResponse is the wire envelope for /binding/scatter and
// /perturbation/scatter. R is the Pearson correlation of (valA, valB) over
// Points, computed server-side (mirrors Shiny's r=corr(_val_a,_val_b) in
// workspace.py). For Spearman variants this is Pearson-on-ranks → exactly the
// Spearman coefficient by construction. R is SafeFloat: pandas .corr() returns
// NaN when an ±Inf value is present (B-1 inf-parity) or fewer than two finite
// pairs remain, and that serializes as JSON `null`.
//
// AxisLabelA / AxisLabelB carry the per-side axis-label MEASURE (the text after
// "{displayName}: "), computed server-side so the plotted quantity is named
// correctly: under col=log10pval the values are -log10(p) ("-log10(p)") or
// ranks ("rank by p-value"), not the raw column name. The frontend prepends the
// dataset display name. Mirrors reference workspace.py:1175-1188; see
// api.log10pAxisLabel.
type ScatterResponse struct {
	Regulator  string         `json:"regulator"`
	DBA        string         `json:"dbA"`
	DBB        string         `json:"dbB"`
	ColA       string         `json:"colA"`
	ColB       string         `json:"colB"`
	AxisLabelA string         `json:"axisLabelA"`
	AxisLabelB string         `json:"axisLabelB"`
	Method     string         `json:"method"`
	R          SafeFloat      `json:"r"`
	Points     []ScatterPoint `json:"points"`
}
