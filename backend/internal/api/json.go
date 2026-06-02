package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
)

// statusClientClosedRequest (499) marks a response the client abandoned before
// it was ready. Non-standard but widely used (nginx); keeps caller-cancellation
// out of the 5xx error budget.
const statusClientClosedRequest = 499

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
		// A context error means the caller's request ended before the response
		// was ready — NOT a server fault. Since GetOrLoad began honoring caller
		// cancellation (DoChan + select on the request ctx), these must not be
		// mapped to 500 / logged at ERROR (which would page on-call for routine
		// client aborts — e.g. TanStack Query cancels the in-flight request on
		// every sidebar change). The shared loader keeps running and still
		// populates the cache for the next request.
		switch {
		case errors.Is(err, context.Canceled):
			// Client went away. Emit 499 (client closed request); the write is
			// best-effort since the connection is usually already gone.
			slog.Debug("request_canceled", "route", chiRoutePattern(r))
			w.WriteHeader(statusClientClosedRequest)
		case errors.Is(err, context.DeadlineExceeded):
			// The 30s request deadline fired. middleware.Timeout has already
			// written the 504, so writing again here would be a superfluous
			// WriteHeader; just record it at warn (real server-side slowness).
			slog.Warn("request_timeout", "route", chiRoutePattern(r))
		default:
			respondInternalError(w, r, err)
		}
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
