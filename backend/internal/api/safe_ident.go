package api

import "github.com/BrentLab/tfbpshiny-go/backend/internal/db"

// whitelistedIdent returns s unchanged when it matches db.SafeIdentRE;
// panics otherwise. Callers MUST have already verified s against
// Whitelist.CheckDataset / CheckField. This function is the per-request
// tripwire (the manifest gate in db.NewWhitelist is the first line of
// defense). Sharing db.SafeIdentRE guarantees the two call sites can't
// drift apart.
func whitelistedIdent(s string) string {
	if !db.SafeIdentRE.MatchString(s) {
		panic("api: unsafe identifier reached SQL interpolation: " + s)
	}
	return s
}
