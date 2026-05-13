package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

func (s *Server) Healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"alive": true})
}

func (s *Server) Readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	resp := map[string]any{"ready": true}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")

	if s.Pool == nil {
		resp["ready"] = false
		resp["reason"] = "pool not initialized"
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(resp)
		return
	}

	var one int
	if err := s.Pool.DB.QueryRowxContext(ctx, `SELECT 1 FROM artifact_manifest LIMIT 1`).Scan(&one); err != nil {
		resp["ready"] = false
		resp["reason"] = "duckdb canary failed: " + err.Error()
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(resp)
		return
	}
	if s.Cache == nil {
		resp["ready"] = false
		resp["reason"] = "cache not initialized"
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(resp)
		return
	}
	_ = json.NewEncoder(w).Encode(resp)
}
