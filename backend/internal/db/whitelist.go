package db

import (
	"fmt"
	"regexp"
	"strings"
)

// v4 caps. DefaultFilters / LevelDefinitions are forwarded to the
// frontend as opaque JSON; Description is free-text tooltip copy that
// may contain any UTF-8. The caps are defense-in-depth so a hand-edited
// artifact cannot blow up the response body. Frontend MUST HTML-escape
// Description on render.
const (
	maxDefaultFiltersBytes   = 16 * 1024
	maxLevelDefinitionsBytes = 16 * 1024
	maxDescriptionBytes      = 1 * 1024
)

// allowedUIKindOverride is the closed set of values
// field_manifest.ui_kind_override may take. Empty string means "no
// override; use DuckDB-type inference".
var allowedUIKindOverride = map[string]struct{}{
	"":            {},
	"categorical": {},
	"numeric":     {},
	"bool":        {},
}

// allowedNumericLevelSort is the closed set of values
// field_manifest.numeric_level_sort may take.
var allowedNumericLevelSort = map[string]struct{}{
	"":        {},
	"numeric": {},
	"string":  {},
}

// SafeIdentRE matches conservative SQL identifier shape: an ASCII letter
// or underscore followed by alphanumerics or underscores. This is the
// same shape the upstream artifact pipeline guarantees. The pattern is
// load-bearing at two boundaries:
//
//  1. Manifest gate (NewWhitelist): runs once at startup; rejects an
//     artifact whose dataset_manifest / field_manifest contains an
//     identifier that doesn't match. Catches a hand-edited DuckDB file.
//  2. SQL-interpolation tripwire (api.whitelistedIdent): runs per
//     request; rejects an identifier that bypassed (1) somehow. Catches
//     a future handler regression.
//
// Both call sites consult this one regexp so the pattern can't drift.
var SafeIdentRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

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
		if !SafeIdentRE.MatchString(d.DBName) {
			return nil, fmt.Errorf("manifest contains unsafe db_name: %q", d.DBName)
		}
		// effect_col / pvalue_col land in schema_version=3 and are
		// interpolated into SQL by buildResponsiveExpr. Re-verify both
		// here so an upstream compromise can't slip an injection
		// payload through the new manifest columns.
		if d.EffectCol != "" && !SafeIdentRE.MatchString(d.EffectCol) {
			return nil, fmt.Errorf("manifest contains unsafe effect_col for %q: %q", d.DBName, d.EffectCol)
		}
		if d.PValueCol != "" && !SafeIdentRE.MatchString(d.PValueCol) {
			return nil, fmt.Errorf("manifest contains unsafe pvalue_col for %q: %q", d.DBName, d.PValueCol)
		}
		// sample_id_field is interpolated into SQL by the
		// /sample-conditions handler (sample_conditions.go) as the SELECT
		// list's join key. Re-verify the manifest value at startup so a
		// hand-edited DuckDB file cannot smuggle an injection payload
		// through the column.
		if d.SampleIDField != "" && !SafeIdentRE.MatchString(d.SampleIDField) {
			return nil, fmt.Errorf("manifest contains unsafe sample_id_field for %q: %q", d.DBName, d.SampleIDField)
		}
		// v4: validate condition_cols entries (CSV) against SafeIdentRE
		// because these are interpolated into SQL by handlers that emit
		// the sample-condition label. DefaultFilters is opaque JSON and
		// must NOT be interpolated into SQL; we only cap its size as
		// defense-in-depth against a hand-edited artifact.
		//
		// We TrimSpace each token before regex check, but ALSO reject an
		// empty token (e.g. "a,,b" or trailing comma) so the artifact
		// pipeline can't silently emit drift. Rationale: the artifact
		// pipeline owns the canonical CSV; any whitespace or empty
		// element in `condition_cols` indicates a build-side bug and
		// should be visible at startup, not papered over.
		if d.ConditionCols != "" {
			for _, c := range strings.Split(d.ConditionCols, ",") {
				trimmed := strings.TrimSpace(c)
				if trimmed == "" {
					return nil, fmt.Errorf("manifest contains empty condition_cols entry for %q (raw=%q)", d.DBName, d.ConditionCols)
				}
				if trimmed != c {
					return nil, fmt.Errorf("manifest contains whitespace in condition_cols entry for %q: %q", d.DBName, c)
				}
				if !SafeIdentRE.MatchString(trimmed) {
					return nil, fmt.Errorf("manifest contains unsafe condition_cols entry for %q: %q", d.DBName, c)
				}
			}
		}
		if len(d.DefaultFilters) > maxDefaultFiltersBytes {
			return nil, fmt.Errorf("manifest default_filters for %q exceeds %d-byte cap (%d)", d.DBName, maxDefaultFiltersBytes, len(d.DefaultFilters))
		}
		// v5: upstream_cols (CSV) is interpolated into SQL by the condition-
		// choice cascade query, so validate every token against SafeIdentRE
		// with the same no-empty / no-whitespace discipline as condition_cols.
		if d.UpstreamCols != "" {
			for _, c := range strings.Split(d.UpstreamCols, ",") {
				trimmed := strings.TrimSpace(c)
				if trimmed == "" {
					return nil, fmt.Errorf("manifest contains empty upstream_cols entry for %q (raw=%q)", d.DBName, d.UpstreamCols)
				}
				if trimmed != c {
					return nil, fmt.Errorf("manifest contains whitespace in upstream_cols entry for %q: %q", d.DBName, c)
				}
				if !SafeIdentRE.MatchString(trimmed) {
					return nil, fmt.Errorf("manifest contains unsafe upstream_cols entry for %q: %q", d.DBName, c)
				}
			}
		}
		if len(d.Description) > maxDescriptionBytes {
			return nil, fmt.Errorf("manifest dataset description for %q exceeds %d-byte cap (%d)", d.DBName, maxDescriptionBytes, len(d.Description))
		}
	}
	for _, f := range m.Fields {
		if !SafeIdentRE.MatchString(f.DBName) || !SafeIdentRE.MatchString(f.Field) {
			return nil, fmt.Errorf("manifest contains unsafe field: %q.%q", f.DBName, f.Field)
		}
		// v4: validate closed-set fields and cap free-text / JSON blobs.
		// ui_kind_override / numeric_level_sort are exact-match against
		// a small enum; the JSON-shaped fields are forwarded opaquely.
		if _, ok := allowedUIKindOverride[f.UIKindOverride]; !ok {
			return nil, fmt.Errorf("manifest ui_kind_override out of set for %q.%q: %q", f.DBName, f.Field, f.UIKindOverride)
		}
		if _, ok := allowedNumericLevelSort[f.NumericLevelSort]; !ok {
			return nil, fmt.Errorf("manifest numeric_level_sort out of set for %q.%q: %q", f.DBName, f.Field, f.NumericLevelSort)
		}
		if len(f.LevelDefinitions) > maxLevelDefinitionsBytes {
			return nil, fmt.Errorf("manifest level_definitions for %q.%q exceeds %d-byte cap (%d)", f.DBName, f.Field, maxLevelDefinitionsBytes, len(f.LevelDefinitions))
		}
		if len(f.Description) > maxDescriptionBytes {
			return nil, fmt.Errorf("manifest description for %q.%q exceeds %d-byte cap (%d)", f.DBName, f.Field, maxDescriptionBytes, len(f.Description))
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
