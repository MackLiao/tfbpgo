export const warmThresholds = {
  http_req_failed:   ['rate==0'],
  http_req_duration: ['p(95)<200', 'p(99)<500'],
  // Custom — cache_hit_ratio tracked via tags below.
};

// openModelThresholds — gates for the authoritative open-model (arrival-rate)
// perf scenarios. dropped_iterations==0 asserts the server kept up with the
// target arrival rate (k6 drops queued iterations when VUs are saturated).
export const openModelThresholds = {
  http_req_failed:    ['rate==0'],
  http_req_duration:  ['p(95)<200', 'p(99)<500'],
  dropped_iterations: ['count==0'],
};

// availabilityThresholds — looser budget for the long-running availability /
// soak scenario, which also adds a Rate('readyz_available') in-scenario.
export const availabilityThresholds = {
  http_req_failed: ['rate<0.005'],
};
