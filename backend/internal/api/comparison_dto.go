package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/queries"
)

func (s *Server) ComparisonDTO(w http.ResponseWriter, r *http.Request) {
	// /comparison/dto takes no inputs that affect the response shape, so
	// the canonical key has no query component. Any extra query params an
	// attacker sends are ignored by the cache key.
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, nil)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), key, func() ([]byte, error) {
		ctx, cancel := context.WithTimeout(r.Context(), db.QueryTimeout)
		defer cancel()
		t0 := time.Now()
		rows := []domain.DTORow{}
		if err := s.Pool.DB.SelectContext(ctx, &rows, queries.Get("comparison/dto.sql")); err != nil {
			return nil, err
		}
		elapsed := time.Since(t0)
		AddDBMillis(r.Context(), elapsed.Milliseconds())
		if s.Metrics != nil {
			s.Metrics.DBDuration.WithLabelValues("comparison/dto").Observe(elapsed.Seconds())
		}
		return json.Marshal(domain.DTOResponse{Rows: rows})
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}
