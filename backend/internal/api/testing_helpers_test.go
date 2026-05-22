package api

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/observability"
	_ "github.com/marcboeker/go-duckdb/v2"
	"github.com/stretchr/testify/require"
)

// bootstrappedFixturePath copies the read-only fixture to a tmp file and
// returns the path. The committed fixture is fully self-contained as of
// Phase 3 (manifests + derived tables are baked in by build_fixture).
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

	wl, err := db.NewWhitelist(mfs)
	require.NoError(t, err)

	srv := &Server{
		ArtifactVersion: mfs.Artifact.ArtifactVersion,
		Pool:            pool,
		Cache:           c,
		Whitelist:       wl,
		Manifests:       mfs,
		Metrics:         observability.New(),
	}
	// Allocate the per-(db, field) introspection caches up front — matches
	// the server bootstrap's call into WarmIntrospectionCache. Without this,
	// the first DatasetFields request would NPE on s.fieldIntrospect.
	srv.initIntrospect()
	return srv
}
