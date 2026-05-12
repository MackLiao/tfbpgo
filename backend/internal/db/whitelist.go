package db

import "fmt"

// Whitelist verifies dataset and field identifiers against the manifests
// loaded at startup. The Go service MUST call CheckDataset / CheckField on
// every identifier-shaped input before interpolating it into SQL.
type Whitelist struct {
	datasets map[string]DatasetRow
	fields   map[string]map[string]struct{}
}

func NewWhitelist(m *Manifests) *Whitelist {
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
	return w
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
