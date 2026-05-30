# Head-to-Head Methodology — Go (REST) vs Legacy Python Shiny (WebSocket)

> **Status:** Pinned protocol. This document is the *agreement*. It is committed
> and reviewed **before** any head-to-head run (spec §11 Phase D, §14 Q3). No
> result produced under a workload that deviates from §3 / §8 is admissible.
> Phase D is a **fast-follow, not a cutover blocker** (spec §3, §11).

Related: `docs/superpowers/specs/2026-05-29-loadtest-program-design.md` §9.3 (G3),
§12 pitfall 16 (head-to-head fairness). Drivers: `../scenarios/arrival_slo.js`
(Go) and `./shiny_adapter.js` (Shiny). Result lands in `tests/loadtest-summary.md`.

---

## 1. Why this is pinned BEFORE running

A head-to-head comparison is only admissible if the protocol was agreed in
writing before collecting any numbers. If the methodology is written *after*
seeing results, the author unconsciously picks the framing that favours the
preferred outcome. This document is therefore committed and reviewed **before**
any run. Any run produced under a workload that deviates from §3 or §8 is
inadmissible and must be discarded.

**Why this matters:** Go and Shiny are architecturally asymmetric (stateless
REST vs stateful WebSocket reactive). A naive "both handle N concurrent users"
comparison is meaningless without pinning what "one user action" costs on each
side, and what work is actually equivalent. The mapping table in §4 makes the
equivalence explicit and disputable before the run, not after.

---

## 2. Matched environment

Both arms run on identically-configured `t3.small` (2 vCPU, 2 GB RAM) EC2
instances in the same AWS region, in the same VPC, behind the same Traefik
reverse proxy. Both instances use the **same real `tfbp.duckdb` artifact** (same
sha256), so the underlying data is byte-for-byte identical.

| Dimension | Go arm | Shiny arm |
| --------- | ------ | --------- |
| Host class | `t3.small` | `t3.small` (same or identical-spec) |
| Runtime | Go binary (`tfbp-server`) | Python Shiny (`uvicorn` / `gunicorn`, 1 worker) |
| DB artifact | `tfbp.duckdb` (sha256 pinned, see §8) | same file mounted read-only |
| Reverse proxy | Traefik (same config) | same Traefik instance |
| URL | `tfbindingandperturbation.com` | `legacy.tfbindingandperturbation.com` |
| k6 generator | off-box (different host, NOT the target) | same off-box generator |

**CPU-credit burn precondition:** `t3.small` runs on burstable CPU credits. A
sustained pre-run warm-up that drains credits before the measurement window
would handicap whichever arm starts second. Precaution: restart both containers
at the same wall-clock time; let both idle for 5 minutes (credit accrual) before
the ladder starts.

**Run validity precondition:** `dropped_iterations == 0` on both arms. If the
k6 generator's CPU reaches > 70% (`mpstat 5` on the off-box host) the offered
rate is a lie — recalibrate (`MAX_VUS`, or shard k6) and rerun.

---

## 3. Matched workload (arrival-rate ladder)

Both arms use the **same arrival-rate ladder**: 5 → 40 → 80 req/s, each step
held for 4 minutes with a 30 s ramp. "req/s" means HTTP requests per second for
the Go arm; it means completed Shiny actions per second (one WebSocket
send+response cycle = one action) for the Shiny arm, as defined in §6.

The ladder is run in two postures:

- **Warm:** Go arm uses `WARM=1` (popular keyspace pre-warm before the run);
  Shiny arm is "warm" in the sense that its Python process and DuckDB connection
  are already alive (one throwaway run over the session-open mix before
  measurement starts).
- **Cold:** Go arm runs immediately after `docker compose restart tfbp` (empty
  ristretto cache); Shiny arm restarts its Python process immediately before the
  cold ladder.

Both postures must be run. The warm posture gives the steady-state crossover;
the cold posture gives the honest first-request experience.

The **same regulator pool** and **same dataset names** feed both drivers:
`callingcards`, `harbison` (binding), `hackett` (perturbation). The Go arm
uses `lib/keyspace.js` to resolve the pool; the Shiny adapter uses a fixed-size
sample from the same pool (see §8 for the pinned seed).

---

## 4. Go REST endpoint -> Shiny reactive-action mapping

Each row names one Go endpoint (as driven by `lib/mix.js` WEIGHTS), the
equivalent Shiny reactive action, the Shiny namespaced input id(s) the adapter
sends, and the output id the adapter awaits before recording the action as
complete.

| Go REST endpoint | WEIGHTS share | Equivalent Shiny action | Shiny input id(s) set | Shiny output id awaited |
| ---------------- | ------------- | ----------------------- | --------------------- | ----------------------- |
| `GET /api/v/{v}/datasets` | 4 | Navigate to dataset selection tab | `main_nav` = `"Select Datasets"` | (session-state frame; see §6) |
| `GET /api/v/{v}/regulators/resolve` | 8 | Apply dataset selection (triggers regulator resolution server-side) | `select_datasets-apply_pending` = `1` | `select_datasets-regulator_list` |
| `GET /api/v/{v}/binding` | 34 | Execute binding analysis | `binding-execute_analysis` = `<counter>` | `binding-box_plot_container` |
| `GET /api/v/{v}/binding/corr` | 12 | Execute binding scatter (correlation) | `binding-execute_analysis` = `<counter>`, `binding-view` = `"scatter"` | `binding-scatter_container` |
| `GET /api/v/{v}/perturbation` | 22 | Execute perturbation analysis | `perturbation-execute_analysis` = `<counter>` | `perturbation-volcano_container` |
| `GET /api/v/{v}/comparison/topn` | 14 | Execute comparison (top-N) | `comparison-execute_analysis` = `<counter>` | `comparison-topn_container` |

> **Note on `binding/corr`:** The Go API exposes `/binding/corr` as a distinct
> endpoint; in Shiny this is a view-mode toggle within the binding module. The
> adapter maps it as a binding action with the scatter view flag set. Both
> drive the same underlying DuckDB query, so the mapping is fair.

> **Note on counter inputs:** Shiny reactive buttons increment a counter; the
> adapter sends `<counter> + 1` on each invocation (see `shiny_adapter.js`
> `buildInputs`).

---

## 5. WebSocket-vs-REST fairness caveats

The comparison is structurally honest but not perfectly symmetric. These
asymmetries are acknowledged explicitly so no result can be cherry-picked.

1. **Protocol overhead:** REST is stateless (TCP+TLS handshake amortised by
   HTTP keep-alive). Shiny uses a persistent SockJS/WebSocket connection that
   pays the handshake once per session but carries per-frame overhead on every
   action. The adapter opens one WebSocket per VU (not per action), matching
   how a real browser user would behave.

2. **Compute-on-server:** Shiny renders HTML/JS diff output server-side
   (htmltools/shiny reactive graph). Go returns raw JSON that the React SPA
   renders client-side. The Shiny server bears rendering cost that Go does not.
   This is an **inherent architectural difference**, not a test-setup artifact —
   it is the reason the rewrite exists.

3. **gzip:** Go responses are gzip-encoded at the Traefik layer; Shiny WebSocket
   frames may not be (depends on whether the WS connection negotiates
   `permessage-deflate`). k6 measures wall-clock latency from send to first
   response byte; gzip affects transfer time. Both arms go through Traefik so
   the transport path is symmetric, but frame compression may differ.

4. **think time:** The adapter does NOT insert think time between actions (no
   `sleep()`). Neither does `arrival_slo.js`. This is intentional: open-model
   arrival rate is controlled at the scenario level, not per-VU. Adding think
   time would decouple the offered rate from the measurement; the ladder controls
   req/s directly.

5. **SockJS framing:** SockJS wraps WebSocket messages in an array envelope
   (`a["<json>"]`). The adapter unwraps this (see `frames.js`
   `sockjsFraming`). If the legacy app switches transports (e.g. from SockJS to
   pure WebSocket), the adapter's unwrap logic must be updated. The transport
   in use at capture time is pinned in `frames.js`.

6. **reconnect:** The adapter opens one persistent WebSocket per VU for the
   duration of the scenario. If Shiny closes the session (idle timeout or
   error), the adapter reconnects and re-runs the init handshake. Reconnects
   are counted in the `shiny_reconnects_total` custom metric. A high reconnect
   rate indicates the Shiny session is being recycled under load — an important
   finding, not a test artifact.

7. **Session state:** Shiny maintains per-session reactive state (the graph
   of observers). The adapter initialises a clean session per VU and does not
   share state. Go is stateless (no session). This means Shiny pays session-
   init cost once per VU per ladder step; Go does not. The cold arm explicitly
   includes this cost; the warm arm's VU pool is pre-initialised.

---

## 6. What "one action" means on each side

**Go REST side:** One HTTP request/response cycle. Latency = `http_req_duration`
(k6 built-in). Success = HTTP 2xx.

**Shiny WebSocket side:** One "send inputs → await output" cycle on the same
persistent WebSocket connection.
- Start timestamp: immediately before the `ws.sendText(updateFrame)` call.
- End timestamp: when a server frame arrives that contains the awaited output id
  in its `values` map (see `matchOutput` in `shiny_adapter.js`).
- Success: the output appears in `values` (not in `errors`).
- Failure: either no output frame arrives within `SHINY_ACTION_TIMEOUT` (default
  30 s), or the output appears under `errors`.
- Metrics: `shiny_action_ok` (Rate), `shiny_action_ms` (Trend). These are
  the custom k6 metrics the crossover table reads.

The timeout is deliberately generous (30 s) so a slow-but-alive Shiny server
is not falsely counted as failed. A timeout is a degradation signal, not an
immediate failure. If `shiny_action_ms` p95 exceeds the SLO threshold before
the availability rate drops, that is still a degradation — record both the
rate and the latency.

---

## 7. Pass criterion (the crossover)

The deliverable is the **req/s-at-SLO crossover table**: the highest arrival
rate (req/s) at which each arm still meets the SLO, run at both warm and cold
postures.

**Go SLO** (from `availabilityThresholds` + `arrival_slo.js`):
- `http_req_failed` rate == 0 (warm) / < 0.005 (availability budget)
- `http_req_duration{arm:mix}` p95 < 200 ms (warm)
- `http_req_duration{arm:mix}` p99 < 500 ms (warm)
- `dropped_iterations` == 0 (run validity)

**Shiny SLO** (symmetric, applied to the Shiny adapter metrics):
- `shiny_action_ok` rate >= 0.995 (availability parity with Go's `readyz_available > 0.995`)
- `shiny_action_ms` p95 < 200 ms (same latency budget)
- `shiny_action_ms` p99 < 500 ms

**Pass criterion (G3):** Go meets its availability SLO at the concurrency level
where Shiny degrades below its SLO. "Degrades" means either `shiny_action_ok`
rate drops below 0.995 OR `shiny_action_ms` p99 exceeds 500 ms. The crossover
req/s must be recorded for both postures (warm + cold).

A result where **both** arms degrade at the same rate is also informative — it
means the rewrite has not improved concurrency handling, which is a finding, not
a pass. The crossover table must be filled honestly.

---

## 8. Pinned parameter table (frozen before run)

The operator fills the `<CONFIRM>` cells on the target host before the run and
commits this file. Any cell left blank invalidates the run.

| Parameter | Value | Status |
| --------- | ----- | ------ |
| Ladder rates (req/s) | 5, 40, 80 | PINNED |
| Step hold duration | 4 m each | PINNED |
| Ramp duration per step | 30 s | PINNED |
| Go arm BASE_URL | `https://tfbindingandperturbation.com` | PINNED |
| Shiny arm BASE_URL | `https://legacy.tfbindingandperturbation.com` | PINNED |
| Artifact sha256 | `<CONFIRM before run>` | operator fills |
| k6 host (off-box) | `<CONFIRM — not the same as either target>` | operator fills |
| Regulator pool seed | `42` (fixed in `shiny_adapter.js` setup) | PINNED |
| Regulator pool size | 20 samples from the live `/regulators/resolve` response | PINNED |
| Postures run | warm + cold, both arms | PINNED |
| `ARTIFACT_KIND` | `real` (MUST NOT be `fixture`) | PINNED |
| `SHINY_ACTION_TIMEOUT` | `30000` ms | PINNED |
| `MAX_VUS` Go arm | `400` (same as `arrival_slo.js` default) | PINNED |
| `MAX_VUS` Shiny arm | `400` | PINNED |
| Run date (UTC) | `<CONFIRM before run>` | operator fills |
| Go binary git SHA | `<CONFIRM before run>` | operator fills |

> Any deviation from a PINNED value requires a new methodology review and
> re-commit before the run data is admissible.
