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
	// StaticFS, when non-nil, is mounted as a fallback http.FileServer for
	// any unmatched routes. Phase 2 populates this with the embedded React bundle.
	StaticFS fs.FS

	// --- A5 Select Datasets handler state ---
	// Per-(db, field) DuckDB type introspection and numeric min/max
	// aggregates. Both maps are eagerly allocated by initIntrospect()
	// (invoked from WarmIntrospectionCache at startup), then concurrently
	// read/written under per-cache mutexes for the lifetime of the Server.
	fieldIntrospect *fieldIntrospectCache
	fieldNumeric    *fieldNumericRangeCache
}

func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	// Set X-Content-Type-Options on every response (defense-in-depth against
	// MIME sniffing on any handler — JSON, HTML, /metrics, etc.). Other
	// security headers are applied only to the SPA shell where they matter.
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			next.ServeHTTP(w, req)
		})
	})
	r.Use(middleware.Compress(5))
	r.Use(middleware.Timeout(30 * time.Second))
	r.Use(RequestGuard)
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
		// Per-dataset Select-Datasets endpoints (A5). Registered before the
		// catch-all /regulators routes so chi resolves the /datasets/{db}
		// prefix correctly.
		r.Get("/datasets/{db}/fields", s.DatasetFields)
		r.Get("/datasets/{db}/regulators", s.DatasetRegulators)
		r.Get("/datasets/{db}/sample-conditions", s.SampleConditions)
		r.Get("/selection/matrix", s.SelectionMatrix)
		r.Get("/selection/breakdown", s.SelectionBreakdown)
		r.Get("/regulators/resolve", s.RegulatorsResolve)
		r.Get("/regulators", s.Regulators)
		// Order: /binding/corr and /binding/scatter must register before
		// /binding so chi's route trie does not greedy-match them against
		// the catch-all binding handler. The trie is path-segment-based
		// (so /binding/* would never resolve to /binding's leaf node), but
		// keeping these literal-prefix routes adjacent to /binding makes
		// the override surface easy to read.
		r.Get("/binding/corr", s.BindingCorr)
		r.Get("/binding/scatter", s.BindingScatter)
		r.Get("/binding", s.Binding)
		r.Get("/perturbation/correlations", s.PerturbationCorrelations)
		r.Get("/perturbation/scatter", s.PerturbationScatter)
		r.Get("/perturbation", s.Perturbation)
		r.Get("/comparison/topn", s.ComparisonTopN)
		r.Get("/comparison/dto", s.ComparisonDTO)
		// Export — streams a multi-dataset .tar.gz. The handler detaches
		// from the 30s router-level Timeout via context.WithoutCancel and
		// applies its own 5-minute deadline; see api.ExportTimeout.
		r.Get("/export", s.Export)
	})

	// SPA mounted last so /api/*, /healthz, /readyz, /metrics,
	// and /api/version all take precedence. Real files under dist/ are
	// served verbatim; any other unmatched path falls back to index.html
	// so React Router can resolve client-side routes (e.g. /binding).
	if s.StaticFS != nil {
		fileServer := http.FileServer(http.FS(s.StaticFS))
		r.Handle("/*", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.Method != http.MethodGet && req.Method != http.MethodHead {
				writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
				return
			}
			p := strings.TrimPrefix(req.URL.Path, "/")
			// Reject reserved API/ops paths so an unmatched typo like
			// /api/v/X/typo doesn't get HTML-shimmed by the SPA fallback.
			// These prefixes have their own real routes; anything that
			// reaches the fallback is by definition a 404.
			for _, prefix := range []string{"api/", "healthz", "readyz", "metrics", "_ref/"} {
				if p == prefix || strings.HasPrefix(p, prefix) {
					writeJSONError(w, http.StatusNotFound, "not found")
					return
				}
			}
			if p == "" {
				p = "index.html"
			}
			if info, err := fs.Stat(s.StaticFS, p); err == nil && !info.IsDir() {
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
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
			w.Header().Set("X-Frame-Options", "DENY")
			_, _ = w.Write(index)
		}))
	}

	return r
}
