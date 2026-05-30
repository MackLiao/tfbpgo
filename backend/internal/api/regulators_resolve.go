package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/queries"
)

const (
	maxExplicitTags = 30
)

type resolveResponse struct {
	Regulators []string `json:"regulators"`
	// Truncated is retained for wire compatibility but is now always false:
	// SD-2 removed the silent 1000-tag cap so the modal selects the FULL
	// common-regulator set (matching Shiny's unbounded sorted intersection).
	Truncated bool `json:"truncated"`
}

// resolvePrefixedDataset removes the optional "binding." or "perturbation."
// alias prefix from a dataset name; the raw dataset key is the part after
// the dot. Spec §7.2 documents `binding.<name>` / `perturbation.<name>` as
// convenience aliases for compact filter expressions. Any other prefix is
// rejected with an error. When a prefix is present and the bare name is in
// the manifest, the method also confirms the prefix matches the dataset's
// actual DataType — `binding.hackett` (where hackett is a perturbation) is
// a 400, not a silent re-mapping.
//
// If the bare name is not in the manifest, this returns the bare name
// without error so CheckDataset can produce the canonical "unknown dataset"
// message downstream.
func (s *Server) resolvePrefixedDataset(name string) (string, error) {
	i := strings.IndexByte(name, '.')
	if i < 0 {
		return name, nil
	}
	prefix := name[:i]
	bare := name[i+1:]
	if prefix != "binding" && prefix != "perturbation" {
		return "", fmt.Errorf("unknown dataset prefix %q (only binding./perturbation. allowed)", prefix)
	}
	row, ok := s.Whitelist.Dataset(bare)
	if !ok {
		return bare, nil
	}
	if row.DataType != prefix {
		return "", fmt.Errorf("prefix %q does not match dataset %q (data_type=%q)", prefix, bare, row.DataType)
	}
	return bare, nil
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
		bare, err := s.resolvePrefixedDataset(d)
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

	// SD-1: the resolve must be filter-aware so the common set the modal shows
	// (and writes back) matches the filter-aware matrix cell the user clicked.
	// Parse the active filters, strip regulator_locus_tag from each dataset
	// (computing the regulator set; an IN-list on it would be circular —
	// mirrors workspace.py:253-269), and validate the remaining fields.
	rawFilters := q.Get("filters")
	if err := validateLength("filters", rawFilters, MaxFiltersBytes); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	filters, err := parseFilters(rawFilters)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	for db := range filters {
		filters[db] = stripRegulatorFilter(filters[db])
	}
	if err := s.checkFilterFields(filters); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Canonicalize the cache key so semantically identical requests collapse:
	// `intersect=A,B` and `intersect=B,A` (and `common=A:B` vs `intersect=A,B`)
	// all hash to the same key. Same for `regulators=B,A`. The (stripped)
	// filters participate so a filtered resolve never reuses an unfiltered one.
	canon := url.Values{}
	if len(datasets) > 0 {
		sorted := append([]string{}, datasets...)
		sort.Strings(sorted)
		canon.Set("intersect", strings.Join(sorted, ","))
	}
	if len(explicit) > 0 {
		sortedTags := append([]string{}, explicit...)
		sort.Strings(sortedTags)
		canon.Set("regulators", strings.Join(sortedTags, ","))
	}
	if len(filters) > 0 {
		b, _ := json.Marshal(filters)
		canon.Set("filters", string(b))
	}
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, canon)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), chiRoutePattern(r), key, func() ([]byte, error) {
		return s.buildResolveResponse(r.Context(), datasets, explicit, filters)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

func (s *Server) buildResolveResponse(ctx context.Context, datasets, explicit []string, filters domain.FiltersByDB) ([]byte, error) {
	tags := map[string]struct{}{}

	if len(datasets) > 0 {
		tmpl := queries.Get("regulators/resolve_intersect.sql")
		first := datasets[0]
		// SD-1: each arm is restricted to that dataset's (regulator-stripped)
		// filters. Args are collected in template-positional order: the first
		// arm's WHERE, then each subsequent INTERSECT arm's WHERE.
		var args []any
		firstWhere, firstArgs, err := buildSquirrelWhere(filters[first])
		if err != nil {
			return nil, fmt.Errorf("resolve where %s: %w", first, err)
		}
		args = append(args, firstArgs...)
		var chain strings.Builder
		for _, d := range datasets[1:] {
			w, a, err := buildSquirrelWhere(filters[d])
			if err != nil {
				return nil, fmt.Errorf("resolve where %s: %w", d, err)
			}
			fmt.Fprintf(&chain,
				"INTERSECT SELECT DISTINCT regulator_locus_tag FROM %s_meta%s\n",
				whitelistedIdent(d), whereForDiagonal(w))
			args = append(args, a...)
		}
		sqlStr := strings.NewReplacer(
			"{{first_table}}", whitelistedIdent(first),
			"{{first_where}}", whereForDiagonal(firstWhere),
			"{{intersect_chain}}", chain.String(),
		).Replace(tmpl)

		dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
		defer cancel()
		t0 := time.Now()
		var rows []struct {
			Tag string `db:"tag"`
		}
		if err := s.Pool.DB.SelectContext(dbCtx, &rows, sqlStr, args...); err != nil {
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

	// SD-2: no cap — the modal selects the full common set (Shiny writes the
	// full sorted intersection with no bound).
	return jsonMarshal(resolveResponse{Regulators: out})
}
