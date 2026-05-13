package api

import (
	"net/http"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/go-chi/chi/v5"
)

func (s *Server) Version(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	body, err := jsonMarshal(domain.VersionInfo{
		ArtifactVersion: s.Manifests.Artifact.ArtifactVersion,
		SchemaVersion:   s.Manifests.Artifact.SchemaVersion,
		BuiltAt:         s.Manifests.Artifact.BuiltAt,
		DuckDBVersion:   s.Manifests.Artifact.DuckDBVersion,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_, _ = w.Write(body)
}

func (s *Server) RequireArtifactVersion(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v := chi.URLParam(r, "v")
		if v != s.Manifests.Artifact.ArtifactVersion {
			w.Header().Set("Location", "/api/version")
			http.Error(w, "stale artifact version", http.StatusGone)
			return
		}
		next.ServeHTTP(w, r)
	})
}
