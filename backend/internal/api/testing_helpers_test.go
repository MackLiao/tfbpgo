package api

import (
	"context"
	"database/sql"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/observability"
	_ "github.com/marcboeker/go-duckdb/v2"
	"github.com/stretchr/testify/require"
)

// bootstrappedFixturePath copies the read-only fixture and synthesizes
// the manifest + derived tables. Mirrors db/test_helpers_test.go but is
// duplicated here because that helper is unexported.
func bootstrappedFixturePath(t *testing.T) string {
	t.Helper()
	srcPath, err := filepath.Abs("../../../tests/fixtures/tfbp_test.duckdb")
	require.NoError(t, err)
	dstPath := filepath.Join(t.TempDir(), "bootstrapped.duckdb")
	src, err := os.Open(srcPath)
	require.NoError(t, err)
	defer src.Close()
	dst, err := os.Create(dstPath)
	require.NoError(t, err)
	_, err = io.Copy(dst, src)
	require.NoError(t, err)
	require.NoError(t, dst.Close())

	q := url.Values{}
	q.Set("threads", "1")
	conn, err := sql.Open("duckdb", dstPath+"?"+q.Encode())
	require.NoError(t, err)
	defer conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	stmts := []string{
		`CREATE TABLE artifact_manifest (artifact_version VARCHAR NOT NULL, schema_version INTEGER NOT NULL, built_at TIMESTAMP NOT NULL, source_yaml_sha256 VARCHAR NOT NULL, duckdb_version VARCHAR NOT NULL, parity_tests_passed BOOLEAN NOT NULL)`,
		`INSERT INTO artifact_manifest VALUES ('test-fixture', 2, CURRENT_TIMESTAMP, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'test', false)`,
		`CREATE TABLE dataset_manifest (db_name VARCHAR PRIMARY KEY, data_type VARCHAR NOT NULL, assay VARCHAR NOT NULL, display_name VARCHAR NOT NULL, source_repo VARCHAR NOT NULL, sample_id_field VARCHAR NOT NULL)`,
		`INSERT INTO dataset_manifest VALUES ('callingcards', 'binding', 'CallingCards', 'Calling Cards', 'BrentLab/callingcards', 'gm_id'), ('hackett', 'perturbation', 'overexpression', 'Hackett 2020', 'BrentLab/hackett_2020', 'sample_id')`,
		`CREATE TABLE field_manifest (db_name VARCHAR NOT NULL, field VARCHAR NOT NULL, PRIMARY KEY (db_name, field))`,
		`INSERT INTO field_manifest VALUES ('callingcards', 'target_locus_tag'), ('callingcards', 'score'), ('hackett', 'target_locus_tag'), ('hackett', 'effect'), ('hackett', 'pvalue')`,
		`CREATE TABLE filter_level_cache (db_name VARCHAR NOT NULL, field VARCHAR NOT NULL, level VARCHAR NOT NULL)`,
		`CREATE TABLE hackett_analysis_set (sample_id VARCHAR, regulator_locus_tag VARCHAR, regulator_symbol VARCHAR, mechanism VARCHAR, restriction VARCHAR, time DOUBLE, date VARCHAR, strain VARCHAR)`,
		`CREATE TABLE regulator_display_names (regulator_locus_tag VARCHAR, regulator_symbol VARCHAR, display_name VARCHAR)`,
		`CREATE TABLE dto_expanded (binding_id VARCHAR, perturbation_id VARCHAR, dto_empirical_pvalue DOUBLE, dto_fdr DOUBLE)`,
	}
	for _, s := range stmts {
		_, err := conn.ExecContext(ctx, s)
		require.NoError(t, err)
	}
	return dstPath
}

func newTestServer(t *testing.T) *Server {
	t.Helper()
	bootstrap := bootstrappedFixturePath(t)
	pool, err := db.Open(db.Options{Path: bootstrap, TempDir: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { _ = pool.Close() })

	mfs, err := db.LoadManifests(context.Background(), pool)
	require.NoError(t, err)

	c, err := cache.New(cache.Options{BudgetBytes: 1 << 20})
	require.NoError(t, err)
	t.Cleanup(c.Close)

	return &Server{
		ArtifactVersion: mfs.Artifact.ArtifactVersion,
		Pool:            pool,
		Cache:           c,
		Whitelist:       db.NewWhitelist(mfs),
		Manifests:       mfs,
		Metrics:         observability.New(),
	}
}
