package api

import (
	"fmt"
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
		http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadRequest)
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, r.URL.Query())
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), key, func() ([]byte, error) {
		ctx, cancel := contextWithDB(r.Context(), db.QueryTimeout)
		defer cancel()
		t0 := time.Now()
		var rows []domain.Regulator
		if err := s.Pool.DB.SelectContext(ctx, &rows, queries.Get("regulators/search.sql"), search, search, limit); err != nil {
			return nil, err
		}
		AddDBMillis(r.Context(), time.Since(t0).Milliseconds())
		return jsonMarshal(domain.RegulatorsResponse{Regulators: rows})
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}
