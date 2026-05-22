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
type CorrResponse struct {
	Method string     `json:"method"` // "pearson" | "spearman"
	Col    string     `json:"col"`    // "effect" | "pvalue"
	Pairs  []CorrPair `json:"pairs"`
}

// ScatterPoint is one (target, val_a, val_b) row produced by the
// regulator_scatter_{method}.sql template. For Pearson, val* are raw
// numeric values; for Spearman, val* are RANK() outputs (we still
// represent as float64 — DuckDB INTEGER scanning into float64 widens
// without precision loss for our row counts).
type ScatterPoint struct {
	TargetLocusTag string  `json:"targetLocusTag" db:"target_locus_tag"`
	ValA           float64 `json:"valA" db:"val_a"`
	ValB           float64 `json:"valB" db:"val_b"`
}

// ScatterResponse is the wire envelope for /binding/scatter and
// /perturbation/scatter. R is the Pearson correlation of (valA, valB)
// over Points, computed server-side (mirrors Shiny's
// r=corr(_val_a,_val_b) in workspace.py). For Spearman variants this is
// Pearson-on-ranks → exactly the Spearman coefficient by construction.
type ScatterResponse struct {
	Regulator string         `json:"regulator"`
	DBA       string         `json:"dbA"`
	DBB       string         `json:"dbB"`
	ColA      string         `json:"colA"`
	ColB      string         `json:"colB"`
	Method    string         `json:"method"`
	R         float64        `json:"r"`
	Points    []ScatterPoint `json:"points"`
}
