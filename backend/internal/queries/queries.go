package queries

import (
	"embed"
	"fmt"
	"io/fs"
	"strings"
)

//go:embed datasets/*.sql regulators/*.sql binding/*.sql perturbation/*.sql comparison/*.sql
var files embed.FS

func All() map[string]string {
	out := map[string]string{}
	_ = fs.WalkDir(files, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".sql") {
			return nil
		}
		b, err := files.ReadFile(path)
		if err != nil {
			return err
		}
		out[path] = string(b)
		return nil
	})
	return out
}

func Get(name string) string {
	b, err := files.ReadFile(name)
	if err != nil {
		panic(fmt.Sprintf("queries: missing %q: %v", name, err))
	}
	return string(b)
}
