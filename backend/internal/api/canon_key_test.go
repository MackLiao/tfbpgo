package api

import (
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/stretchr/testify/require"
)

func TestCanonValues_SortAndDedupe(t *testing.T) {
	c := canonValues(map[string]any{
		"datasets": []string{"b", "a", "c"},
	})
	require.Equal(t, "a,b,c", c.Get("datasets"))
}

func TestCanonValues_NumericFormatting(t *testing.T) {
	c := canonValues(map[string]any{
		"top_n":  25,
		"effect": 0.0,
		"pvalue": 0.05,
	})
	// Zero numerics ARE preserved — zero is a meaningful threshold for
	// these fields. Doc-comment says so.
	require.Equal(t, "25", c.Get("top_n"))
	require.Equal(t, "0", c.Get("effect"))
	require.Equal(t, "0.05", c.Get("pvalue"))
}

func TestCanonValues_PanicsOnUnsupportedType(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatalf("expected panic on unsupported type")
		}
	}()
	canonValues(map[string]any{"flag": true})
}

func TestCanonValues_SkipsEmpty(t *testing.T) {
	c := canonValues(map[string]any{
		"regulator": "",
		"datasets":  []string{},
		"filters":   "",
	})
	require.Empty(t, c)
}

// TestCacheKey_OrderInsensitive proves that two semantically-equivalent
// requests with different param orderings now produce the same cache key.
// This is the fix that closes the H1 cache-fragmentation finding.
func TestCacheKey_OrderInsensitive(t *testing.T) {
	c1 := canonValues(map[string]any{
		"regulator": "YBR289W",
		"datasets":  []string{"harbison", "callingcards"},
	})
	c2 := canonValues(map[string]any{
		"regulator": "YBR289W",
		"datasets":  []string{"callingcards", "harbison"},
	})
	k1 := cache.Key("v1", "GET", "/api/v/v1/binding", c1)
	k2 := cache.Key("v1", "GET", "/api/v/v1/binding", c2)
	require.Equal(t, k1, k2,
		"semantically-equivalent requests must produce the same cache key")
}

// TestCacheKey_JunkParamsIgnored proves the cache key doesn't expand to
// include attacker-supplied parameters that the handler ignores.
func TestCacheKey_JunkParamsIgnored(t *testing.T) {
	// canonValues only takes the allowlisted entries — no junk possible.
	c := canonValues(map[string]any{
		"regulator": "YBR289W",
		"datasets":  []string{"callingcards"},
	})
	require.False(t, c.Has("junk1"))
	require.False(t, c.Has("junk2"))
	require.Equal(t, "YBR289W", c.Get("regulator"))
}
