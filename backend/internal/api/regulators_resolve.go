package api

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/queries"
)

const (
	maxExplicitTags = 30
	maxResolvedTags = 1000
)

type resolveResponse struct {
	Regulators []string `json:"regulators"`
	Truncated  bool     `json:"truncated"`
}

// stripDataTypePrefix removes the optional "binding." or "perturbation."
// alias prefix from a dataset name; the raw dataset key is the part after
// the dot. Spec §7.2 documents `binding.<name>` / `perturbation.<name>` as
// convenience aliases for compact filter expressions. Any other prefix is
// rejected with an error.
func stripDataTypePrefix(name string) (string, error) {
	i := strings.IndexByte(name, '.')
	if i < 0 {
		return name, nil
	}
	prefix := name[:i]
	if prefix != "binding" && prefix != "perturbation" {
		return "", fmt.Errorf("unknown dataset prefix %q (only binding./perturbation. allowed)", prefix)
	}
	return name[i+1:], nil
}

// RegulatorsResolve handles GET /api/v/{v}/regulators/resolve.
//
// Query params:
//   - intersect=A,B,C — N-way intersection of regulators across datasets.
//   - common=A:B      — sugar for intersect=A,B (spec §7.2 syntax).
//   - regulators=...  — explicit tag list (<=30, uppercased, deduped); if
//     combined with intersect/common, the response is the intersection.
//
// All dataset names are checked against the manifest whitelist; explicit
// tags are filtered in Go (never interpolated into SQL). Output is sorted
// and capped at maxResolvedTags with `truncated:true` when trimmed.
func (s *Server) RegulatorsResolve(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	// Datasets to intersect; `common=A:B` is sugar for `intersect=A,B`.
	dsCSV := q.Get("intersect")
	if c := q.Get("common"); c != "" {
		dsCSV = strings.ReplaceAll(c, ":", ",")
	}
	// Strip optional binding./perturbation. alias prefixes before dedupe+cap so
	// the count cap is enforced against canonical bare names.
	rawDS := splitCSV(dsCSV)
	bareList := make([]string, 0, len(rawDS))
	for _, d := range rawDS {
		bare, err := stripDataTypePrefix(d)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		bareList = append(bareList, bare)
	}
	datasets, err := dedupeAndCapCSV("datasets", bareList, len(s.Whitelist.AllDatasets()))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	for _, d := range datasets {
		if err := s.Whitelist.CheckDataset(d); err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	// Explicit tag list (<=30 by raw count, then deduped + uppercased).
	rawTags := splitCSV(q.Get("regulators"))
	if len(rawTags) > maxExplicitTags {
		writeJSONError(w, http.StatusBadRequest,
			fmt.Sprintf("regulators: too many (got %d, max %d)", len(rawTags), maxExplicitTags))
		return
	}
	explicit := make([]string, 0, len(rawTags))
	seen := map[string]struct{}{}
	for _, t := range rawTags {
		x := strings.ToUpper(strings.TrimSpace(t))
		if x == "" {
			continue
		}
		if _, ok := seen[x]; ok {
			continue
		}
		seen[x] = struct{}{}
		explicit = append(explicit, x)
	}

	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, q)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), key, func() ([]byte, error) {
		return s.buildResolveResponse(r.Context(), datasets, explicit)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

func (s *Server) buildResolveResponse(ctx context.Context, datasets, explicit []string) ([]byte, error) {
	tags := map[string]struct{}{}

	if len(datasets) > 0 {
		tmpl := queries.Get("regulators/resolve_intersect.sql")
		first := datasets[0]
		var chain strings.Builder
		for _, d := range datasets[1:] {
			fmt.Fprintf(&chain,
				"INTERSECT SELECT DISTINCT regulator_locus_tag FROM %s_meta\n",
				quoteIdent(d))
		}
		sqlStr := strings.NewReplacer(
			"{{first_table}}", quoteIdent(first),
			"{{intersect_chain}}", chain.String(),
		).Replace(tmpl)

		dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
		defer cancel()
		t0 := time.Now()
		var rows []struct {
			Tag string `db:"tag"`
		}
		if err := s.Pool.DB.SelectContext(dbCtx, &rows, sqlStr); err != nil {
			return nil, fmt.Errorf("resolve intersect: %w", err)
		}
		elapsed := time.Since(t0)
		AddDBMillis(ctx, elapsed.Milliseconds())
		if s.Metrics != nil {
			s.Metrics.DBDuration.WithLabelValues("regulators/resolve").Observe(elapsed.Seconds())
		}
		for _, row := range rows {
			tags[row.Tag] = struct{}{}
		}
	}

	if len(explicit) > 0 {
		if len(datasets) == 0 {
			for _, t := range explicit {
				tags[t] = struct{}{}
			}
		} else {
			explicitSet := make(map[string]struct{}, len(explicit))
			for _, t := range explicit {
				explicitSet[t] = struct{}{}
			}
			for t := range tags {
				if _, ok := explicitSet[t]; !ok {
					delete(tags, t)
				}
			}
		}
	}

	out := make([]string, 0, len(tags))
	for t := range tags {
		out = append(out, t)
	}
	sort.Strings(out)

	resp := resolveResponse{Regulators: out}
	if len(out) > maxResolvedTags {
		resp.Regulators = out[:maxResolvedTags]
		resp.Truncated = true
	}
	return jsonMarshal(resp)
}
