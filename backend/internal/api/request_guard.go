package api

import (
	"log/slog"
	"net/http"
	"strings"
)

// Request-guard caps. Tuned generously — legitimate clients of the
// documented API surface use at most ~6 distinct query keys per request,
// and the longest legitimate value is the JSON-encoded ?filters= (already
// capped at MaxFiltersBytes elsewhere).
const (
	// MaxQueryKeys caps the number of distinct query parameter keys per
	// request. Above this, the handler short-circuits with 400 so an
	// attacker fuzzing junk keys cannot expand the cache namespace.
	MaxQueryKeys = 32
	// MaxQueryValueBytes caps the length of any single query parameter
	// value. The 16 KiB cap on ?filters= sets the practical ceiling; we
	// add a small overhead margin for URL-encoding expansion.
	MaxQueryValueBytes = 32 * 1024
)

// RequestGuard rejects API requests with too many distinct query keys or
// oversized per-value lengths before any handler runs. This is the second
// line of defense behind the per-handler canonValues allowlist (which is
// the primary defense against cache-namespace expansion). The guard is
// scoped to /api/* so SPA navigation with marketing/UTM params is not
// affected, even at high cardinality.
func RequestGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery == "" {
			next.ServeHTTP(w, r)
			return
		}
		// Scope the guard to /api/* paths only — ops endpoints (/healthz,
		// /readyz, /metrics) and the SPA fallback don't build cache keys
		// and shouldn't see JSON error bodies on legitimate URL params.
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		q := r.URL.Query()
		if len(q) > MaxQueryKeys {
			slog.Warn("request_guard_reject",
				"reason", "too_many_query_keys",
				"count", len(q),
				"path", r.URL.Path,
			)
			writeJSONError(w, http.StatusBadRequest, "too many query parameters")
			return
		}
		for _, vs := range q {
			for _, v := range vs {
				if len(v) > MaxQueryValueBytes {
					slog.Warn("request_guard_reject",
						"reason", "value_too_large",
						"bytes", len(v),
						"path", r.URL.Path,
					)
					writeJSONError(w, http.StatusBadRequest, "query parameter value too large")
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}
