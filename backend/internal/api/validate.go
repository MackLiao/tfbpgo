package api

import (
	"fmt"
	"strings"
)

// Input caps to prevent DoS via oversized query strings or pathological
// inputs. These are intentionally generous — real clients never come close.
const (
	// MaxFiltersBytes caps the raw `?filters=` JSON body before unmarshal.
	MaxFiltersBytes = 16 * 1024
	// MaxSearchChars caps the `?search=` parameter for /regulators.
	MaxSearchChars = 64
	// TopNMin / TopNMax bound the user-supplied `?top_n=` value. 1000 is
	// the upper bound for any reasonable UI — heatmaps lose readability
	// well before then. The cap is also a DoS guard: each row produced
	// here is a row materialized into the per-pair CTE.
	TopNMin = 1
	TopNMax = 1000
)

// validateLength returns a 400-ready error when val exceeds max bytes.
func validateLength(name, val string, max int) error {
	if len(val) > max {
		return fmt.Errorf("%s exceeds maximum length (%d > %d)", name, len(val), max)
	}
	return nil
}

// dedupeAndCapCSV normalizes splitCSV output: removes duplicate entries
// while preserving first-seen order, and rejects (returns nil + error)
// inputs whose count exceeds maxItems. maxItems == 0 disables the count
// cap and only deduplication is applied.
func dedupeAndCapCSV(name string, items []string, maxItems int) ([]string, error) {
	if maxItems > 0 && len(items) > maxItems {
		return nil, fmt.Errorf("%s exceeds maximum entries (%d > %d)", name, len(items), maxItems)
	}
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, it := range items {
		if _, ok := seen[it]; ok {
			continue
		}
		seen[it] = struct{}{}
		out = append(out, it)
	}
	return out, nil
}

// clampTopN returns top_n in [TopNMin, TopNMax]; defaults to 25 on invalid.
func clampTopN(raw string, def int) int {
	v := atoiOr(raw, def)
	if v < TopNMin {
		return def
	}
	if v > TopNMax {
		return TopNMax
	}
	return v
}

// trimAndCapSearch returns the trimmed search string and an error when it
// exceeds MaxSearchChars (counted as bytes; ASCII tokens in practice).
func trimAndCapSearch(s string) (string, error) {
	s = strings.TrimSpace(s)
	if len(s) > MaxSearchChars {
		return "", fmt.Errorf("search exceeds maximum length (%d > %d)", len(s), MaxSearchChars)
	}
	return s, nil
}
