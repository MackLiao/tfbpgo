package db

import (
	"context"
	"database/sql"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "github.com/marcboeker/go-duckdb/v2"
	"github.com/stretchr/testify/require"
)

// bootstrappedFixturePath copies the read-only test fixture to a tmp file
// and synthesizes the four manifest tables that build_from_fixture would
// produce. Returns the tmp file path.
func bootstrappedFixturePath(t *testing.T) string {
	t.Helper()

	srcPath := fixturePath(t)
	dstPath := filepath.Join(t.TempDir(), "bootstrapped.duckdb")
	src, err := os.Open(srcPath)
	require.NoError(t, err)
	defer src.Close()
	dst, err := os.Create(dstPath)
	require.NoError(t, err)
	_, err = io.Copy(dst, src)
	require.NoError(t, err)
	require.NoError(t, dst.Close())

	// Open read-write briefly to add manifest tables.
	q := url.Values{}
	q.Set("threads", "1")
	dsn := dstPath + "?" + q.Encode()
	conn, err := sql.Open("duckdb", dsn)
	require.NoError(t, err)
	defer conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	stmts := []string{
		`CREATE TABLE artifact_manifest (
			artifact_version    VARCHAR NOT NULL,
			schema_version      INTEGER NOT NULL,
			built_at            TIMESTAMP NOT NULL,
			source_yaml_sha256  VARCHAR NOT NULL,
			duckdb_version      VARCHAR NOT NULL,
			parity_tests_passed BOOLEAN NOT NULL
		)`,
		`INSERT INTO artifact_manifest VALUES (
			'test-fixture', 2, CURRENT_TIMESTAMP,
			'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
			'test', false
		)`,
		`CREATE TABLE dataset_manifest (
			db_name         VARCHAR PRIMARY KEY,
			data_type       VARCHAR NOT NULL,
			assay           VARCHAR NOT NULL,
			display_name    VARCHAR NOT NULL,
			source_repo     VARCHAR NOT NULL,
			sample_id_field VARCHAR NOT NULL
		)`,
		`INSERT INTO dataset_manifest VALUES
			('callingcards', 'binding', 'CallingCards', 'Calling Cards', 'BrentLab/callingcards', 'gm_id'),
			('hackett', 'perturbation', 'overexpression', 'Hackett 2020', 'BrentLab/hackett_2020', 'sample_id')`,
		`CREATE TABLE field_manifest (
			db_name VARCHAR NOT NULL,
			field   VARCHAR NOT NULL,
			PRIMARY KEY (db_name, field)
		)`,
		`INSERT INTO field_manifest VALUES
			('callingcards', 'target_locus_tag'),
			('callingcards', 'score'),
			('hackett', 'target_locus_tag'),
			('hackett', 'effect'),
			('hackett', 'pvalue')`,
		`CREATE TABLE filter_level_cache (
			db_name VARCHAR NOT NULL,
			field   VARCHAR NOT NULL,
			level   VARCHAR NOT NULL
		)`,
	}
	for _, s := range stmts {
		_, err := conn.ExecContext(ctx, s)
		require.NoError(t, err, "stmt failed: %s", s)
	}
	require.NoError(t, conn.Close())

	return dstPath
}
