package api

import "net/http"

func (s *Server) RefIndex(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) }
func (s *Server) RefView(w http.ResponseWriter, r *http.Request)  { http.NotFound(w, r) }
