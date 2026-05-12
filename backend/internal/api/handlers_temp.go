package api

import "net/http"

// Temporary stubs for handlers introduced in Task 11. Replaced by health.go and version.go.

func (s *Server) Healthz(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) }
func (s *Server) Readyz(w http.ResponseWriter, r *http.Request)  { http.NotFound(w, r) }
func (s *Server) Version(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) }

func (s *Server) RequireArtifactVersion(next http.Handler) http.Handler {
	return next
}
