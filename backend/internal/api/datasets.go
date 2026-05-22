package api

import (
	"encoding/json"
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
		// every entry against SafeIdentRE; TrimSpace mirrors the
		// startup check (NewWhitelist), so a stray space anywhere on
		// the line cannot drift between the two boundaries.
		cc := []string{}
		if d.ConditionCols != "" {
			for _, tok := range strings.Split(d.ConditionCols, ",") {
				tok = strings.TrimSpace(tok)
				if tok == "" {
					continue
				}
				cc = append(cc, tok)
			}
		}
		// DefaultFilters lives in the manifest as a Go string carrying
		// JSON bytes. Forward as json.RawMessage so the wire format is
		// a JSON object, not a JSON-encoded string. Empty manifest
		// value → nil RawMessage → JSON null.
		var df json.RawMessage
		if d.DefaultFilters != "" {
			df = json.RawMessage(d.DefaultFilters)
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
			DefaultFilters: df,
			ConditionCols:  cc,
		})
	}
	return jsonMarshal(out)
}
