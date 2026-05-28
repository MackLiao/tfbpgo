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

// quotedIdent returns s as a double-quoted SQL identifier after verifying it
// against db.SafeIdentRE (via whitelistedIdent). Use at every identifier-
// interpolation site so SQL reserved-keyword column names (e.g. `end` on
// chec_m2025 / rossi) parse unambiguously instead of tripping the DuckDB
// parser. SafeIdentRE restricts s to [A-Za-z_][A-Za-z0-9_]*, so it can carry
// no embedded double-quote and no escaping is required. Panics (via
// whitelistedIdent) on an unsafe value.
func quotedIdent(s string) string {
	return `"` + whitelistedIdent(s) + `"`
}
