package api

import (
	"encoding/json"
	"net/http"
	"strings"
)

func jsonMarshal(v any) ([]byte, error) { return json.Marshal(v) }

// writeJSONError writes {"error":"<msg>"} with the given status code. Used
// for client-facing 4xx validation errors where the message is intentional.
func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func (s *Server) writeCachedJSON(w http.ResponseWriter, r *http.Request, body []byte, hit bool, err error) {
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
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
