package api

import (
	"crypto/sha256"
	"encoding/base64"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/observability"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// defaultMaxInFlight bounds concurrent in-flight requests to the DB-backed API
// group when Server.MaxInFlight is unset. Sized as a small multiple of the
// 2-connection pool: cache hits drain fast; cold misses queue on the pool while
// the cap keeps resident goroutines/memory bounded on a t3.small.
const defaultMaxInFlight = 128

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

	// MaxInFlight caps concurrent in-flight requests to the DB-backed API
	// group. <= 0 falls back to defaultMaxInFlight. Set from config in main.
	MaxInFlight int

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
	r.Use(RequestGuard)
	r.Use(RequestLogger(s.ArtifactVersion, s.Metrics))

	r.Get("/healthz", s.Healthz)
	r.Get("/readyz", s.Readyz)
	r.Get("/api/version", s.Version)

	if s.Metrics != nil {
		r.Handle("/metrics", promhttp.HandlerFor(s.Metrics.Reg, promhttp.HandlerOpts{}))
	}

	maxInFlight := s.MaxInFlight
	if maxInFlight <= 0 {
		maxInFlight = defaultMaxInFlight
	}

	r.Route("/api/v/{v}", func(r chi.Router) {
		// Load-shed before requests reach the 2-connection DuckDB pool.
		// Without this, unbounded concurrent requests on an unauthenticated
		// public endpoint pile up goroutines + request bodies + 30s contexts
		// against mem_limit=1.6g (swap disabled) → OOM. ThrottleBacklog admits
		// `maxInFlight` concurrently, queues up to 2x more for a short window,
		// then returns 429. Health/metrics/version are registered above this
		// group so liveness/readiness probes always respond while the API sheds.
		r.Use(middleware.ThrottleBacklog(maxInFlight, maxInFlight*2, 5*time.Second))
		r.Use(s.RequireArtifactVersion)

		// All DB-backed read endpoints get the 30s per-request deadline.
		// /export is deliberately registered OUTSIDE this group: it streams a
		// multi-dataset .tar.gz for up to api.ExportTimeout (5 min) and detaches
		// via context.WithoutCancel. Under middleware.Timeout, chi writes a 504
		// in a defer once the 30s deadline trips, racing a superfluous
		// WriteHeader against the already-streamed 200 body.
		r.Group(func(r chi.Router) {
			r.Use(middleware.Timeout(30 * time.Second))
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
		})
		r.Get("/export", s.Export)
	})

	// SPA mounted last so /api/*, /healthz, /readyz, /metrics,
	// and /api/version all take precedence. Real files under dist/ are
	// served verbatim; any other unmatched path falls back to index.html
	// so React Router can resolve client-side routes (e.g. /binding).
	if s.StaticFS != nil {
		fileServer := http.FileServer(http.FS(s.StaticFS))
		// Read the SPA shell once; the embedded bundle is immutable for the
		// life of the process. The CSP is derived from its actual inline
		// scripts (see cspForIndex), so a frontend rebuild can never strand
		// a stale hash.
		indexBytes, indexErr := fs.ReadFile(s.StaticFS, "index.html")
		var indexCSP string
		if indexErr == nil {
			indexCSP = cspForIndex(indexBytes)
		}
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
			// `/` and `/index.html` must NOT take the fileServer branch below:
			// the SPA shell needs the no-store + CSP headers set only by the
			// fallback path. (Previously a bare `GET /` was served by the
			// FileServer with no Cache-Control or security headers at all.)
			if p == "" || p == "index.html" {
				p = "index.html"
			} else if info, err := fs.Stat(s.StaticFS, p); err == nil && !info.IsDir() {
				// Vite content-hashes every filename under assets/ (e.g.
				// plotly-Cluy4Xu1.js), so those bytes can never change for a
				// given URL — cache forever, mirroring the /api/v/* immutable
				// strategy. Without this, embed.FS's zero ModTime defeats
				// ETag/Last-Modified and every visit re-downloads the ~MB
				// Plotly chunk. Unhashed root files (favicons, index.html via
				// the fallback below) are excluded.
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				fileServer.ServeHTTP(w, req)
				return
			}
			// SPA fallback: serve index.html so React Router owns the path.
			if indexErr != nil {
				http.NotFound(w, req)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Content-Security-Policy", indexCSP)
			_, _ = w.Write(indexBytes)
		}))
	}

	return r
}

// inlineScriptRE matches attribute-less <script> blocks in the SPA shell —
// i.e. inline scripts like the `window.global = window` Plotly shim. Bundle
// references use <script type="module" ... src=...> and do not match.
var inlineScriptRE = regexp.MustCompile(`(?s)<script>(.*?)</script>`)

// cspForIndex builds the Content-Security-Policy for the SPA shell. Everything
// is same-origin: the SPA bundles Plotly (verified: no `new Function`/eval, so
// no 'unsafe-eval') and calls only /api/*. style-src needs 'unsafe-inline' for
// Plotly/React inline styles; img-src needs data:/blob: for Plotly mode-bar
// icons and PNG export. Inline scripts are allowed by sha256 hash, computed
// from the shipped index.html itself so the policy tracks frontend edits.
func cspForIndex(index []byte) string {
	scriptSrc := "'self'"
	for _, m := range inlineScriptRE.FindAllSubmatch(index, -1) {
		sum := sha256.Sum256(m[1])
		scriptSrc += " 'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	}
	return "default-src 'self'; script-src " + scriptSrc +
		"; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
		"font-src 'self' data:; connect-src 'self'; object-src 'none'; " +
		"frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
}
