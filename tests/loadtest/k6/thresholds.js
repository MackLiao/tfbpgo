export const warmThresholds = {
  http_req_failed:   ['rate==0'],
  http_req_duration: ['p(95)<200', 'p(99)<500'],
  // Custom — cache_hit_ratio tracked via tags below.
};
