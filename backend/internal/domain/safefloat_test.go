package domain

import (
	"encoding/json"
	"math"
	"testing"
)

func TestSafeFloat_MarshalJSON(t *testing.T) {
	cases := []struct {
		name string
		in   SafeFloat
		want string
	}{
		{"finite", SafeFloat(1.5), "1.5"},
		{"zero", SafeFloat(0), "0"},
		{"negative", SafeFloat(-2.25), "-2.25"},
		{"integral", SafeFloat(3.0), "3"},
		{"nan", SafeFloat(math.NaN()), "null"},
		{"posinf", SafeFloat(math.Inf(1)), "null"},
		{"neginf", SafeFloat(math.Inf(-1)), "null"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b, err := json.Marshal(tc.in)
			if err != nil {
				t.Fatalf("Marshal(%v) returned error: %v", float64(tc.in), err)
			}
			if string(b) != tc.want {
				t.Fatalf("Marshal(%v) = %s, want %s", float64(tc.in), b, tc.want)
			}
		})
	}
}

// TestSafeFloat_InStructSlice is the load-bearing case: encoding/json fails
// the WHOLE marshal if any contained float64 is NaN/Inf. SafeFloat must let
// a NaN-carrying row serialize (as null) so a single bad measurement value
// can't 500 the entire response.
func TestSafeFloat_InStructSlice(t *testing.T) {
	type row struct {
		V SafeFloat `json:"v"`
	}
	b, err := json.Marshal([]row{{V: SafeFloat(math.NaN())}, {V: SafeFloat(3.0)}})
	if err != nil {
		t.Fatalf("Marshal slice containing NaN failed: %v", err)
	}
	const want = `[{"v":null},{"v":3}]`
	if string(b) != want {
		t.Fatalf("got %s want %s", b, want)
	}
}

// TestSafeFloat_FiniteMatchesFloat64 pins that finite values serialize
// byte-identically to a plain float64 field, so swapping float64 -> SafeFloat
// on a wire type cannot drift the JSON (parity byte-stability).
func TestSafeFloat_FiniteMatchesFloat64(t *testing.T) {
	for _, v := range []float64{0, 1, -1, 1.5, 0.1, 1e-6, 1e21, -3.14159, 12345.6789} {
		got, err := json.Marshal(SafeFloat(v))
		if err != nil {
			t.Fatalf("Marshal(SafeFloat(%v)) error: %v", v, err)
		}
		want, _ := json.Marshal(v)
		if string(got) != string(want) {
			t.Fatalf("SafeFloat(%v) = %s, plain float64 = %s", v, got, want)
		}
	}
}
