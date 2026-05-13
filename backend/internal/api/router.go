package api

import (
	"net/http"
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
		r.Get("/regulators", s.Regulators)
		r.Get("/binding", s.Binding)
		r.Get("/perturbation", s.Perturbation)
		r.Get("/comparison/topn", s.ComparisonTopN)
		r.Get("/comparison/dto", s.ComparisonDTO)
	})

	r.Get("/_ref", s.RefIndex)
	r.Get("/_ref/{view}", s.RefView)

	return r
}
