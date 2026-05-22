package api

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
)

// AssertHandlerMapsCoverManifest verifies that every dataset in
// dataset_manifest carries the columns the Go handlers need.
//
// In schema_version=3 the previously hard-coded Go maps
// (bindingMeasurementColumn / pertMeasurementColumn) were removed; the
// handlers now read `effect_col` straight from dataset_manifest. This
// assertion still runs at startup and refuses to start the listener if
// any selectable dataset has an empty effect_col — e.g. an upstream YAML
// edit slipped past the data_prep ValueError gate. Operators upgrading
// the artifact ahead of the binary get a clean fail-fast.
//
// bindingConfigs / pertConfigs (in comparison_topn.go) are intentionally
// NOT validated here: they carry per-dataset business logic (sample col,
// rank direction, harbison dedup, hackett time filter) that does not
// trivially generalize to a manifest column. A dataset may be
// /binding-eligible but not /comparison/topn-eligible; that asymmetry
// is checked at request time with a 400.
func AssertHandlerMapsCoverManifest(m *db.Manifests) error {
	var missing []string
	for _, d := range m.Datasets {
		switch d.DataType {
		case "binding":
			if d.EffectCol == "" {
				missing = append(missing, fmt.Sprintf("binding %q: empty manifest effect_col", d.DBName))
			}
		case "perturbation":
			if d.EffectCol == "" {
				missing = append(missing, fmt.Sprintf("perturbation %q: empty manifest effect_col", d.DBName))
			}
		default:
			// Unknown data_type — likely a schema_version bump that
			// shipped ahead of the binary. Fail-fast so we don't 500
			// on the first request that touches this dataset.
			missing = append(missing,
				fmt.Sprintf("dataset %q: unknown data_type %q (binary too old for this artifact?)",
					d.DBName, d.DataType))
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("handler-config drift vs dataset_manifest:\n  - %s",
			strings.Join(missing, "\n  - "))
	}

	// Non-fatal: surface datasets that are manifest-eligible but absent from
	// the topn-specific config maps (bindingConfigs / pertConfigs in
	// comparison_topn.go). Those datasets still serve via /binding,
	// /perturbation, /comparison/dto etc.; only /comparison/topn rejects
	// them at request time. A startup log-warn surfaces drift earlier than
	// the first 400 response in production logs.
	for _, d := range m.Datasets {
		switch d.DataType {
		case "binding":
			if _, ok := bindingConfigs[d.DBName]; !ok {
				slog.Warn("startup_topn_config_missing",
					"data_type", "binding",
					"db_name", d.DBName,
					"effect", "dataset cannot be used by /comparison/topn until added to bindingConfigs",
				)
			}
		case "perturbation":
			if _, ok := pertConfigs[d.DBName]; !ok {
				slog.Warn("startup_topn_config_missing",
					"data_type", "perturbation",
					"db_name", d.DBName,
					"effect", "dataset cannot be used by /comparison/topn until added to pertConfigs",
				)
			}
		}
	}
	return nil
}
