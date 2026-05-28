package domain

import (
	"encoding/json"
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
