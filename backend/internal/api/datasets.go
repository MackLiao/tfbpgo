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
		// Parse the condition_cols / upstream_cols CSVs → []string on the
		// server so the JSON contract is clean (see csvToFields).
		cc := csvToFields(d.ConditionCols)
		uc := csvToFields(d.UpstreamCols)
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
			UpstreamCols:   uc,
			Description:    d.Description,
		})
	}
	return jsonMarshal(out)
}

// csvToFields parses a comma-separated manifest column (condition_cols /
// upstream_cols) into a clean []string. The manifest gate (NewWhitelist) has
// already validated every entry against SafeIdentRE with no-empty/no-whitespace
// discipline; the TrimSpace + skip-empty here mirror that so a stray space
// cannot drift between the two boundaries. Always returns a non-nil slice so
// the JSON contract is an array, never null.
func csvToFields(csv string) []string {
	out := []string{}
	if csv == "" {
		return out
	}
	for _, tok := range strings.Split(csv, ",") {
		tok = strings.TrimSpace(tok)
		if tok == "" {
			continue
		}
		out = append(out, tok)
	}
	return out
}
