// Package static owns the embedded SPA bundle. The Phase 2 React build
// drops its compiled output into the dist/ subdirectory (via Vite's
// `outDir: ../backend/static/dist`) and the binary picks it up at compile
// time via //go:embed. A build of the Go binary therefore strictly
// requires a prior `cd frontend && pnpm build`.
package static

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var files embed.FS

// FS returns the embedded SPA tree rooted at dist/.
func FS() fs.FS {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		// Build invariant: //go:embed all:dist must populate dist/.
		// If this returns an error the binary won't serve the SPA, but
		// the API still works.
		return files
	}
	return sub
}
