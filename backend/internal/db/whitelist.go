package db

import (
	"fmt"
	"regexp"
)

// safeIdent matches conservative SQL identifier shape: an ASCII letter or
// underscore followed by alphanumerics or underscores. This is the same
// shape the upstream artifact pipeline guarantees; we re-verify here so a
// hand-edited DuckDB file fails fast instead of leaking past the whitelist
// at runtime.
var safeIdent = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Whitelist verifies dataset and field identifiers against the manifests
// loaded at startup. The Go service MUST call CheckDataset / CheckField on
// every identifier-shaped input before interpolating it into SQL.
type Whitelist struct {
	datasets map[string]DatasetRow
	fields   map[string]map[string]struct{}
}

// NewWhitelist constructs a Whitelist from manifests. It re-verifies every
// dataset and field name against safeIdent so an upstream compromise (a
// hand-edited DuckDB file with a malicious db_name) is caught at startup
// instead of becoming a runtime SQL-injection vector.
func NewWhitelist(m *Manifests) (*Whitelist, error) {
	for _, d := range m.Datasets {
		if !safeIdent.MatchString(d.DBName) {
			return nil, fmt.Errorf("manifest contains unsafe db_name: %q", d.DBName)
		}
	}
	for _, f := range m.Fields {
		if !safeIdent.MatchString(f.DBName) || !safeIdent.MatchString(f.Field) {
			return nil, fmt.Errorf("manifest contains unsafe field: %q.%q", f.DBName, f.Field)
		}
	}
	w := &Whitelist{
		datasets: make(map[string]DatasetRow, len(m.Datasets)),
		fields:   make(map[string]map[string]struct{}),
	}
	for _, d := range m.Datasets {
		w.datasets[d.DBName] = d
	}
	for _, f := range m.Fields {
		if _, ok := w.fields[f.DBName]; !ok {
			w.fields[f.DBName] = make(map[string]struct{})
		}
		w.fields[f.DBName][f.Field] = struct{}{}
	}
	return w, nil
}

func (w *Whitelist) CheckDataset(dbName string) error {
	if _, ok := w.datasets[dbName]; !ok {
		return fmt.Errorf("unknown dataset: %q", dbName)
	}
	return nil
}

func (w *Whitelist) Dataset(dbName string) (DatasetRow, bool) {
	d, ok := w.datasets[dbName]
	return d, ok
}

func (w *Whitelist) CheckField(dbName, field string) error {
	fs, ok := w.fields[dbName]
	if !ok {
		return fmt.Errorf("unknown dataset: %q", dbName)
	}
	if _, ok := fs[field]; !ok {
		return fmt.Errorf("unknown field %q for dataset %q", field, dbName)
	}
	return nil
}

func (w *Whitelist) AllDatasets() []DatasetRow {
	out := make([]DatasetRow, 0, len(w.datasets))
	for _, d := range w.datasets {
		out = append(out, d)
	}
	return out
}
