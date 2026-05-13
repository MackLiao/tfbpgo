# k6 load tests

Phase 3 acceptance harness. Two scenarios live here:

- `profile.js` — steady-state throughput / latency profile against a
  long-running server, used to validate the §6.7 SLOs.
- `cold_burst.js` — cache-cold burst that drives singleflight coalescing and
  observes `cache_admission_rejected_total` / `cache_oversize_responses_total`.

Phase 1 ships only the skeletons; Phase 3 fleshes them out.

## Running

```
make loadtest-profile
make loadtest-cold-burst
```

Both targets assume `k6` is installed locally
(see [https://k6.io/docs/getting-started/installation/](https://k6.io/docs/getting-started/installation/))
and a Phase 1 backend is reachable at `http://127.0.0.1:8080`. Override with
`-e BASE_URL=...`.
