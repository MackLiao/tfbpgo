// Package static owns the embedded SPA bundle. The Phase 2 React build
// drops its compiled output into this directory and the binary picks it up
// at compile time. The .gitkeep keeps the directory present until the SPA
// lands.
package static

import (
	"embed"
	"io/fs"
)

//go:embed *.html
var files embed.FS

// FS returns the embedded SPA tree (currently just index.html).
func FS() fs.FS { return files }
