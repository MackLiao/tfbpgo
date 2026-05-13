package api

import (
	"context"
	"embed"
	"fmt"
	"html/template"
	"net/http"
	"net/http/httptest"

	"github.com/go-chi/chi/v5"
)

//go:embed templates/*.html
var refTemplates embed.FS

var refTpl = template.Must(template.ParseFS(refTemplates, "templates/*.html"))

// RefIndex renders the parity-aid landing page linking to per-module views.
func (s *Server) RefIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = refTpl.ExecuteTemplate(w, "base.html", map[string]any{
		"Title":   "Reference Views",
		"Version": s.ArtifactVersion,
	})
}

// RefView dispatches /_ref/{view} to the matching template, executing the
// underlying API handler against the server itself to capture its JSON body.
// Pure side-by-side aid; no styling effort.
func (s *Server) RefView(w http.ResponseWriter, r *http.Request) {
	view := chi.URLParam(r, "view")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	switch view {
	case "datasets":
		body, err := s.buildDatasetsResponse()
		if err != nil {
			respondInternalError(w, r, err)
			return
		}
		_ = refTpl.ExecuteTemplate(w, "datasets.html", string(body))

	case "binding":
		body := s.proxyForRefView(r, "/api/v/"+s.ArtifactVersion+"/binding", s.Binding)
		_ = refTpl.ExecuteTemplate(w, "binding.html", map[string]any{
			"Query": r.URL.RawQuery,
			"Body":  body,
		})

	case "perturbation":
		body := s.proxyForRefView(r, "/api/v/"+s.ArtifactVersion+"/perturbation", s.Perturbation)
		_ = refTpl.ExecuteTemplate(w, "perturbation.html", map[string]any{
			"Query": r.URL.RawQuery,
			"Body":  body,
		})

	case "comparison":
		body := s.proxyForRefView(r, "/api/v/"+s.ArtifactVersion+"/comparison/topn", s.ComparisonTopN)
		_ = refTpl.ExecuteTemplate(w, "comparison.html", map[string]any{
			"Query": r.URL.RawQuery,
			"Body":  body,
		})

	default:
		http.NotFound(w, r)
	}
}

// proxyForRefView re-runs the request against an in-process handler to capture
// the JSON body. Returns the body or an error message rendered as text.
func (s *Server) proxyForRefView(r *http.Request, path string, h http.HandlerFunc) string {
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, path+"?"+r.URL.RawQuery, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("v", s.ArtifactVersion)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		return fmt.Sprintf("HTTP %d\n\n%s", rr.Code, rr.Body.String())
	}
	return rr.Body.String()
}
