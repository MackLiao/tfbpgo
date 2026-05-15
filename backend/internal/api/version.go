package api

import (
	"net/http"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/go-chi/chi/v5"
)

func (s *Server) Version(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	body, err := jsonMarshal(domain.VersionInfo{
		ArtifactVersion: s.Manifests.Artifact.ArtifactVersion,
		SchemaVersion:   s.Manifests.Artifact.SchemaVersion,
		BuiltAt:         s.Manifests.Artifact.BuiltAt,
		DuckDBVersion:   s.Manifests.Artifact.DuckDBVersion,
	})
	if err != nil {
		respondInternalError(w, r, err)
		return
	}
	_, _ = w.Write(body)
}

func (s *Server) RequireArtifactVersion(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v := chi.URLParam(r, "v")
		if v != s.Manifests.Artifact.ArtifactVersion {
			// 410 Gone signals "the version-pinned URL is permanently
			// unavailable; refetch /api/version". Location is advisory —
			// HTTP doesn't honor it on 410 but clients can read it.
			w.Header().Set("Location", "/api/version")
			writeJSONError(w, http.StatusGone, "stale artifact version")
			return
		}
		next.ServeHTTP(w, r)
	})
}
