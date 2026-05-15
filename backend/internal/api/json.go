package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
)

func jsonMarshal(v any) ([]byte, error) { return json.Marshal(v) }

// writeJSONError writes {"error":"<msg>"} with the given status code. Used
// for client-facing 4xx validation errors where the message is intentional.
// Sets Cache-Control: no-store so an upstream CDN cannot cache a 4xx for a
// per-client URL.
func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// respondInternalError logs the underlying error with route context and
// returns a sanitized JSON 500 response so internal details (file paths,
// SQL fragments, stack frames) never leak to clients.
func respondInternalError(w http.ResponseWriter, r *http.Request, err error) {
	// Log the chi route pattern (low cardinality) rather than the full
	// path so log aggregators don't explode on attacker-fuzzed URLs.
	slog.Error("handler_failed", "route", chiRoutePattern(r), "err", err.Error())
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusInternalServerError)
	_, _ = w.Write([]byte(`{"error":"internal error"}`))
}

func (s *Server) writeCachedJSON(w http.ResponseWriter, r *http.Request, body []byte, hit bool, err error) {
	if err != nil {
		respondInternalError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if strings.HasPrefix(r.URL.Path, "/api/v/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-store")
	}
	if hit {
		w.Header().Set("X-Cache", "HIT")
	} else {
		w.Header().Set("X-Cache", "MISS")
	}
	_, _ = w.Write(body)
}
