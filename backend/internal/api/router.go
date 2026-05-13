package api

import (
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/observability"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Server holds dependencies for HTTP handlers.
type Server struct {
	ArtifactVersion string
	Pool            *db.Pool
	Cache           *cache.Cache
	Whitelist       *db.Whitelist
	Manifests       *db.Manifests
	Metrics         *observability.Metrics
	// EnableReferenceViews mounts the /_ref/* parity-aid HTML pages when true.
	// Disabled by default; enable in dev/test via ENABLE_REFERENCE_VIEWS=true.
	EnableReferenceViews bool
	// StaticFS, when non-nil, is mounted as a fallback http.FileServer for
	// any unmatched routes. Phase 2 will populate this with the React bundle.
	StaticFS fs.FS
}

func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(middleware.Compress(5))
	r.Use(middleware.Timeout(30 * time.Second))
	r.Use(RequestLogger(s.ArtifactVersion, s.Metrics))

	r.Get("/healthz", s.Healthz)
	r.Get("/readyz", s.Readyz)
	r.Get("/api/version", s.Version)

	if s.Metrics != nil {
		r.Handle("/metrics", promhttp.HandlerFor(s.Metrics.Reg, promhttp.HandlerOpts{}))
	}

	r.Route("/api/v/{v}", func(r chi.Router) {
		r.Use(s.RequireArtifactVersion)
		r.Get("/datasets", s.Datasets)
		r.Get("/regulators/resolve", s.RegulatorsResolve)
		r.Get("/regulators", s.Regulators)
		r.Get("/binding", s.Binding)
		r.Get("/perturbation", s.Perturbation)
		r.Get("/comparison/topn", s.ComparisonTopN)
		r.Get("/comparison/dto", s.ComparisonDTO)
	})

	if s.EnableReferenceViews {
		r.Get("/_ref", s.RefIndex)
		r.Get("/_ref/{view}", s.RefView)
	}

	// SPA mounted last so /api/*, /_ref/*, /healthz, /readyz, /metrics,
	// and /api/version all take precedence. Real files under dist/ are
	// served verbatim; any other unmatched path falls back to index.html
	// so React Router can resolve client-side routes (e.g. /binding).
	if s.StaticFS != nil {
		fileServer := http.FileServer(http.FS(s.StaticFS))
		r.Handle("/*", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			path := strings.TrimPrefix(req.URL.Path, "/")
			if path == "" {
				path = "index.html"
			}
			if _, err := fs.Stat(s.StaticFS, path); err == nil {
				fileServer.ServeHTTP(w, req)
				return
			}
			// SPA fallback: serve index.html so React Router owns the path.
			index, err := fs.ReadFile(s.StaticFS, "index.html")
			if err != nil {
				http.NotFound(w, req)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			_, _ = w.Write(index)
		}))
	}

	return r
}
