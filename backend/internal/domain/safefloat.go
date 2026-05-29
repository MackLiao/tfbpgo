package domain

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
)

// SafeFloat is a float64 that marshals non-finite IEEE values (NaN, ±Inf) as
// JSON `null` instead of failing the whole encode. Go's encoding/json rejects
// NaN/Inf with "json: unsupported value", which means a single non-finite
// measurement value (e.g. harbison.effect / harbison.pvalue carry IEEE NaN on
// the real artifact) would otherwise 500 the entire response. Emitting null
// mirrors the Python/pandas reference, which renders missing measurements as
// gaps rather than erroring.
//
// Finite values marshal byte-identically to a plain float64 (we delegate to
// encoding/json), so swapping a float64 wire field to SafeFloat does not drift
// the JSON output for finite data. DuckDB DOUBLE columns scan into SafeFloat
// via database/sql's reflection path (underlying kind is float64).
type SafeFloat float64

// MarshalJSON implements json.Marshaler.
func (f SafeFloat) MarshalJSON() ([]byte, error) {
	v := float64(f)
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return []byte("null"), nil
	}
	return json.Marshal(v)
}

// Scan implements sql.Scanner so a SafeFloat column can be NULL. A SQL NULL
// scans to NaN, which MarshalJSON then emits as JSON `null` — so a missing
// measurement (NULL) and a non-finite one (NaN/Inf) both render as a gap,
// matching the pandas reference. Without this, database/sql's reflection path
// errors when scanning a NULL into the float64-kind SafeFloat. Integer ranks
// (DuckDB BIGINT from the Spearman scatter's RANK()) and DOUBLE values both
// scan through here too.
func (f *SafeFloat) Scan(src any) error {
	switch v := src.(type) {
	case nil:
		*f = SafeFloat(math.NaN())
		return nil
	case float64:
		*f = SafeFloat(v)
		return nil
	case float32:
		*f = SafeFloat(v)
		return nil
	case int64:
		*f = SafeFloat(v)
		return nil
	case int32:
		*f = SafeFloat(v)
		return nil
	default:
		// Fallback for the byte/string/decimal forms a driver might hand back.
		var nf sql.NullFloat64
		if err := nf.Scan(src); err != nil {
			return fmt.Errorf("SafeFloat.Scan: unsupported source type %T: %w", src, err)
		}
		if !nf.Valid {
			*f = SafeFloat(math.NaN())
		} else {
			*f = SafeFloat(nf.Float64)
		}
		return nil
	}
}
