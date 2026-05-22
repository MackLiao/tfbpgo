package api

import (
	"net/http"
	"strings"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
)

func (s *Server) Datasets(w http.ResponseWriter, r *http.Request) {
	// /datasets ignores query params entirely; canonical key has none so
	// junk-key fuzzing cannot expand the cache namespace.
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, nil)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), key, func() ([]byte, error) {
		return s.buildDatasetsResponse()
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

func (s *Server) buildDatasetsResponse() ([]byte, error) {
	fieldsByDB := map[string][]string{}
	for _, f := range s.Manifests.Fields {
		fieldsByDB[f.DBName] = append(fieldsByDB[f.DBName], f.Field)
	}
	out := domain.DatasetsResponse{}
	for _, d := range s.Manifests.Datasets {
		// Parse condition_cols CSV → []string on the server so the JSON
		// contract is clean. The manifest gate has already validated
		// every entry against SafeIdentRE.
		var cc []string
		if d.ConditionCols != "" {
			cc = strings.Split(d.ConditionCols, ",")
		} else {
			cc = []string{}
		}
		out.Datasets = append(out.Datasets, domain.DatasetEntry{
			DBName:         d.DBName,
			DataType:       d.DataType,
			Assay:          d.Assay,
			DisplayName:    d.DisplayName,
			SourceRepo:     d.SourceRepo,
			SampleIDField:  d.SampleIDField,
			Fields:         fieldsByDB[d.DBName],
			DefaultActive:  d.DefaultActive,
			DefaultFilters: d.DefaultFilters,
			ConditionCols:  cc,
		})
	}
	return jsonMarshal(out)
}
