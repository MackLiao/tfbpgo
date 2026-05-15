package api

import (
	"fmt"
	"strings"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
)

// AssertHandlerMapsCoverManifest verifies that every dataset in
// dataset_manifest has a matching entry in the appropriate handler-side
// configuration map (bindingMeasurementColumn / bindingConfigs for
// data_type=binding, and pertMeasurementColumn / pertConfigs for
// data_type=perturbation).
//
// Until the Phase 1.6 migration moves these maps into dataset_manifest,
// drift between the artifact and the binary is invisible at startup.
// A missing entry surfaces only when a user hits the affected handler
// — as a 500 from buildBindingResponse/buildPerturbationResponse, or
// (for comparison/topn) as a 400 from the per-pair config check.
//
// This assertion runs at startup and refuses to start the listener if
// the manifest contains a dataset the binary cannot serve. Operators
// upgrading the artifact ahead of the binary get a clean fail-fast.
func AssertHandlerMapsCoverManifest(m *db.Manifests) error {
	var missing []string
	for _, d := range m.Datasets {
		switch d.DataType {
		case "binding":
			if _, ok := bindingMeasurementColumn[d.DBName]; !ok {
				missing = append(missing, fmt.Sprintf("binding %q: no entry in bindingMeasurementColumn", d.DBName))
			}
			// bindingConfigs / pertConfigs are consulted only by
			// comparison/topn; a dataset may be /binding-eligible but
			// not /comparison/topn-eligible. That asymmetry is checked
			// at request time with a 400, intentionally not here.
		case "perturbation":
			if _, ok := pertMeasurementColumn[d.DBName]; !ok {
				missing = append(missing, fmt.Sprintf("perturbation %q: no entry in pertMeasurementColumn", d.DBName))
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
	return nil
}
