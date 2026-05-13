# k6 load tests

Phase 3 acceptance harness. Two scenarios live here:

- `profile.js` — steady-state throughput / latency profile against a
  long-running server, used to validate the §6.7 SLOs.
- `cold_burst.js` — cache-cold burst that drives singleflight coalescing and
  observes `cache_admission_rejected_total` / `cache_oversize_responses_total`.

Shared modules:

- `thresholds.js` — exports `warmThresholds` (the §11.3.3 warm-cache gates:
  zero 5xx, p95 < 200 ms, p99 < 500 ms).
- `lib/random_query.js` — popular/varied regulator and dataset pickers used by
  the warm profile's action mix.

## Running

```
make loadtest-profile
make loadtest-cold-burst
```

Both targets assume `k6` is installed locally
(see [https://k6.io/docs/getting-started/installation/](https://k6.io/docs/getting-started/installation/))
and a Phase 1 backend is reachable at `http://127.0.0.1:8080`. Override with
`-e BASE_URL=...`.

## profile — warm-cache load profile

Ramps to 50 VUs over 1 minute, holds for 8 minutes, ramps down over 1 minute.
Each VU picks one of three traffic segments per iteration (60% popular
regulator on a cache-friendly URL, 30% varied regulator, 10% deep-filter
`comparison/topn`) and sleeps 2–8 s between iterations to mimic real user
think time. `setup()` resolves the artifact version once via `/api/version`
and passes it into every iteration so cache keys are stable.

Gates (from `thresholds.js`):

- `http_req_failed: rate==0`
- `http_req_duration: p(95) < 200 ms, p(99) < 500 ms`

Run the full 10-minute profile during cutover:

```bash
k6 run --out csv=warm-profile.csv tests/loadtest/k6/profile.js
```

Save the CSV alongside the cutover commit for the §11.3.3 acceptance record.

## cold_burst — singleflight gate

This test requires the backend cache to be cold for the target URL. Restart
the backend immediately before running so that ristretto is empty and the
target URL has never been served:

```bash
make backend-run &
sleep 3
make loadtest-cold-burst
kill %1
```

The script's `setup()` snapshots `cache_hits_total` before the burst and
emits a `console.warn` if it is non-zero (the backend is not cold). The
target URL uses `regulator=YML007W` so it does not collide with
`profile.js`'s `YBR289W` warm-cache priming.

After the run, the script prints the relevant `/metrics` lines. Verify:

- `singleflight_shared_calls_total` increased by ≥ 99 (gate — 99 of the 100
  concurrent VUs found an in-flight call and waited on it)
- `db_query_duration_seconds_count{endpoint="binding/data"}` increased by
  exactly 1 (gate — only the singleflight loader ran the SQL)
- `cache_misses_total` increased by exactly 1
- `cache_hits_total` did **not** increase during the burst — singleflight
  waiters receive the shared result and the loader populates the cache once
  at the end of the burst, so none of the 100 in-burst requests register as
  hits. Subsequent requests after the burst settles would be hits.

**Do not re-run `cold_burst.js` against a backend that has already served the
target URL** — the ristretto cache will be warm and the singleflight assertion
will not hold. Always restart the backend (or pick a fresh URL the backend
has never seen) before each run.
