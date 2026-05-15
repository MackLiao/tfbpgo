package api

import (
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// canonValues builds an allowlisted, normalized url.Values for use as a
// cache key. Each entry is one of:
//   - string: added as-is; empty strings are skipped (typically optional fields)
//   - []string: sorted then joined by ','; empty slices are skipped
//   - int: stringified via strconv.Itoa; zero is preserved (zero is a
//     meaningful threshold for top_n, effect, etc.)
//   - float64: stringified via strconv.FormatFloat ('g', precision=-1);
//     zero is preserved for the same reason as int
//
// Any other type panics — this is a defense-in-depth tripwire so a future
// contributor adding a new param type (e.g., bool) cannot silently drop it
// and produce cache-key collisions across distinct flag values.
//
// Returning a url.Values keyed by allowlisted names guarantees that an
// attacker fuzzing extra query keys (?junk=1&junk2=2...) cannot expand
// the cache namespace: the extras are never read here, so they cannot
// reach cache.Key.
func canonValues(entries map[string]any) url.Values {
	out := url.Values{}
	for k, v := range entries {
		switch t := v.(type) {
		case string:
			if t == "" {
				continue
			}
			out.Set(k, t)
		case []string:
			if len(t) == 0 {
				continue
			}
			sorted := make([]string, len(t))
			copy(sorted, t)
			sort.Strings(sorted)
			out.Set(k, strings.Join(sorted, ","))
		case int:
			out.Set(k, strconv.Itoa(t))
		case float64:
			out.Set(k, strconv.FormatFloat(t, 'g', -1, 64))
		default:
			panic("canonValues: unsupported type for key " + k)
		}
	}
	return out
}
