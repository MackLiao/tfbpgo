package api

import "net/http"

func (s *Server) Datasets(w http.ResponseWriter, r *http.Request)       { http.NotFound(w, r) }
func (s *Server) Regulators(w http.ResponseWriter, r *http.Request)     { http.NotFound(w, r) }
func (s *Server) Binding(w http.ResponseWriter, r *http.Request)        { http.NotFound(w, r) }
func (s *Server) Perturbation(w http.ResponseWriter, r *http.Request)   { http.NotFound(w, r) }
func (s *Server) ComparisonTopN(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) }
func (s *Server) ComparisonDTO(w http.ResponseWriter, r *http.Request)  { http.NotFound(w, r) }
func (s *Server) RefIndex(w http.ResponseWriter, r *http.Request)       { http.NotFound(w, r) }
func (s *Server) RefView(w http.ResponseWriter, r *http.Request)        { http.NotFound(w, r) }
