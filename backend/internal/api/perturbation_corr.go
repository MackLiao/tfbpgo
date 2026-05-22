package api

import "net/http"

// PerturbationCorrelations serves /api/v/{v}/perturbation/correlations —
// the perturbation analogue of /binding/corr. Path name uses the plural
// "correlations" to match docs/parity/perturbation.md so the React side
// has a single canonical name to consume. The handler logic is symmetric
// with BindingCorr; both delegate to serveCorr with dataType wired to
// "binding" / "perturbation".
func (s *Server) PerturbationCorrelations(w http.ResponseWriter, r *http.Request) {
	s.serveCorr(w, r, "perturbation")
}

// PerturbationScatter serves /api/v/{v}/perturbation/scatter — the
// perturbation analogue of /binding/scatter. See BindingScatter for the
// per-target-pair behavior and the server-side Pearson r computation.
func (s *Server) PerturbationScatter(w http.ResponseWriter, r *http.Request) {
	s.serveScatter(w, r, "perturbation")
}
