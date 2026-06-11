# Demo load test — `realistic_mix.js` on `v0.0.3-demo` (realistic user mix)

**Run date:** 2026-06-11 ~18:05–18:15Z · **Script:** `tests/loadtest/k6/realistic_mix.js`
**Target:** `https://tfbp-demo.16-59-86-154.nip.io` (single `t3.small`, us-east-2, `i-0a84a67d658895c1e`)
**Generator:** off-box (laptop) · **Image:** `ghcr.io/mackliao/tfbpgo:v0.0.3-demo` · **artifactVersion:** `2026-06-11` (real ~2.9 GB artifact)
**Load:** `ramping-vus` 0→50→hold 8 m→0 (~10 m). Mix: 70 % popular binding / 22 % varied binding / 5 % perturbation / **3 % comparison/topn with DEFAULT cacheable params** (top_n=25, effect=0, pvalue=0.05; common dataset pairs). 2–8 s think time.

> Companion to the adversarial `profile.js` run (`2026-06-11-demo-profile-v0.0.3.md`). This models what a real user crowd experiences: binding-heavy browsing with occasional comparison deep-dives on common, cacheable parameters — rather than `profile.js`'s 10 % always-cold comparison stress.

## Headline — clean sweep

| Metric | Value |
| --- | --- |
| **`http_req_failed`** | **0.00 % (0 / 4586)** |
| **Server-side status tally** | **4632 × 200, zero non-2xx** |
| checks (`popular 200`, `topn 200`) | **100 % (3365/3365)** |
| `http_reqs` | 4586 @ 7.64/s |
| overall `http_req_duration` p95 / max | **3.04 s / 8.3 s** (no 30 s timeouts) |
| **comparison/topn** p95 (cache hit) | **140 ms** (avg 74 ms, max 509 ms), `topn_cache_hit` **100 %** |
| popular binding p95 | 2.71 s (avg 886 ms, med 556 ms), `popular_cache_hit` **100 %** |
| data received | 4.6 GB |

## Health diagnostics (all green)

| Signal | Value | Reads as |
| --- | --- | --- |
| `db_pool_wait_count` Δ | **0** | pool never contended — not a single wait |
| cache hit rate over run | 4581 hits / 4 miss = **99.9 %** | fully warm |
| `cache_evictions` / `admission_rejected` / `oversize` Δ | 0 / 0 / 0 | ristretto healthy, budget fine |
| CPU credit balance | 145.4 → **146.7** (rose) | load too light to dent credits — **no throttle** |
| `process_resident_memory_bytes` | 548 MB | far under the 1.6 g limit |
| `go_goroutines` | 17 | no goroutine pileup |

## Interpretation

- **Under 50 concurrent users with a realistic mix, the service handled 4,586 requests with zero failures and zero server-side errors.** Comparison views — the operation that froze the site pre-fix — now return in **~140 ms** (100 % cache hit) and never touch the pool under contention.
- **The comparison-arm tail from `profile.js` is gone.** Overall p95 dropped 11.6 s → **3.04 s** and max 30.3 s → **8.3 s**, because real comparison traffic uses cacheable default params (singleflight + ristretto absorb it) instead of `profile.js`'s synthetic always-cold queries that serialized on the size-1 semaphore.
- **The only remaining cost is latency, not correctness.** `popular` binding shows p95 2.71 s even at 100 % cache hit and zero pool wait — that is pure CPU-scheduling contention from 50 concurrent VUs on a **2-vCPU burstable box** (TLS + ristretto serialization + Go scheduler), not DB, pool, cache, or memory (all had headroom; credits even rose). A non-burstable ≥4-vCPU instance removes it.

## vs. the adversarial `profile.js` run (same box, same VUs)

| Metric | `profile.js` (10 % always-cold cmp) | **`realistic_mix.js` (3 % cacheable cmp)** |
| --- | --- | --- |
| `http_req_failed` | 0.22 % (9 × 504) | **0.00 %** |
| server non-2xx | 9 × 504 | **0** |
| overall p95 / max | 11.6 s / 30.3 s | **3.04 s / 8.3 s** |
| comparison arm | always-cold, serialized on semaphore | **100 % cache hit, p95 140 ms** |
| `db_pool_wait_count` Δ | 1 | **0** |
| cache hit rate | 89 % | **99.9 %** |
| CPU credits | 148.5 → 144.7 | 145.4 → **146.7** (earned) |

## Bottom line for the PI

On a single throwaway `t3.small`, the Go rewrite serves a realistic 50-concurrent-user load with **0 % errors** and sub-second median latency, comparison views returning in ~140 ms. The elevated p95 (~3 s) is the 2-vCPU demo box being CPU-bound under that concurrency — correctness is already perfect, and a right-sized instance brings latency down. The legacy single-process Shiny app cannot sustain this concurrency at all (its failure mode under load was the reason for the rewrite).

Artifacts: `realistic_v0.0.3-demo_run.txt` (full k6 stdout, gitignored), `realistic_v0.0.3-demo_summary.json` (k6 metric export).
