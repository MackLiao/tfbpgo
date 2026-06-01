package api

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/queries"
)

func (s *Server) Regulators(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	search, err := trimAndCapSearch(q.Get("search"))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	canon := canonValues(map[string]any{
		"search": search,
		"limit":  limit,
	})
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, canon)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), chiRoutePattern(r), key, func(loadCtx context.Context) ([]byte, error) {
		ctx, cancel := contextWithDB(loadCtx, db.QueryTimeout)
		defer cancel()
		t0 := time.Now()
		var rows []domain.Regulator
		if err := s.Pool.DB.SelectContext(ctx, &rows, queries.Get("regulators/search.sql"), search, search, limit); err != nil {
			return nil, err
		}
		elapsed := time.Since(t0)
		AddDBMillis(r.Context(), elapsed.Milliseconds())
		if s.Metrics != nil {
			s.Metrics.DBDuration.WithLabelValues("regulators/search").Observe(elapsed.Seconds())
		}
		return jsonMarshal(domain.RegulatorsResponse{Regulators: rows})
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}
