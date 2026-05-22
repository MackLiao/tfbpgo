package api

import (
	"archive/tar"
	"compress/gzip"
	"encoding/csv"
	"io"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestExport_HappyPath confirms that requesting two datasets streams a
// well-formed tar.gz with the documented six files (2 datasets × 3
// files each). It also asserts the response Content-Type and
// Content-Disposition match the spec.
func TestExport_HappyPath(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"datasets": []string{"callingcards,hackett"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/export?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, "body: %s", rr.Body.String())
	require.Equal(t, "application/gzip", rr.Header().Get("Content-Type"))
	cd := rr.Header().Get("Content-Disposition")
	require.True(t, strings.HasPrefix(cd, `attachment; filename="tfbp-export-`),
		"unexpected Content-Disposition: %q", cd)
	require.True(t, strings.HasSuffix(cd, `.tar.gz"`),
		"unexpected Content-Disposition: %q", cd)
	require.Equal(t, "no-store", rr.Header().Get("Cache-Control"))

	gz, err := gzip.NewReader(rr.Body)
	require.NoError(t, err)
	defer gz.Close()
	tr := tar.NewReader(gz)

	files := map[string][]byte{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
		buf, err := io.ReadAll(tr)
		require.NoError(t, err)
		files[hdr.Name] = buf
	}

	want := []string{
		"callingcards/metadata.csv",
		"callingcards/annotated_features.csv",
		"callingcards/README.md",
		"hackett/metadata.csv",
		"hackett/annotated_features.csv",
		"hackett/README.md",
	}
	require.Len(t, files, len(want), "got files: %v", keys(files))
	for _, name := range want {
		require.Contains(t, files, name, "missing tar entry %q", name)
		require.NotEmpty(t, files[name], "empty tar entry %q", name)
	}

	// Header parse — both CSVs should have a non-empty column row that
	// includes a sample identifier column. We don't pin the exact set
	// because the fixture's schema can evolve.
	rows, err := csv.NewReader(strings.NewReader(string(files["callingcards/metadata.csv"]))).ReadAll()
	require.NoError(t, err)
	require.NotEmpty(t, rows, "metadata.csv must have at least a header row")
	header := rows[0]
	require.NotEmpty(t, header)
	require.True(t, containsAny(header, []string{"sample_id", "regulator_locus_tag"}),
		"metadata header should contain a sample/regulator column; got %v", header)

	// README sanity — should mention the db_name.
	require.Contains(t, string(files["callingcards/README.md"]), "callingcards")
}

func TestExport_RejectsUnknownDataset(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"datasets": []string{"definitely_not_a_dataset"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/export?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code, "body: %s", rr.Body.String())
}

func TestExport_RejectsMissingDatasets(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/export", nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code, "body: %s", rr.Body.String())
}

func TestExport_RejectsBadFilterField(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"datasets": []string{"callingcards"},
		"filters":  []string{`{"callingcards":{"definitely_not_a_field":{"type":"categorical","value":["x"]}}}`},
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/export?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code, "body: %s", rr.Body.String())
}

func keys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func containsAny(haystack, needles []string) bool {
	set := make(map[string]struct{}, len(haystack))
	for _, h := range haystack {
		set[h] = struct{}{}
	}
	for _, n := range needles {
		if _, ok := set[n]; ok {
			return true
		}
	}
	return false
}
