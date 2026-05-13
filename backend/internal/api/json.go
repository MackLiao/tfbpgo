package api

import (
	"encoding/json"
	"net/http"
	"strings"
)

func jsonMarshal(v any) ([]byte, error) { return json.Marshal(v) }

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
