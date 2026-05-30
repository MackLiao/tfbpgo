# Head-to-Head Run Procedure — Go vs Legacy Shiny (Phase D, G3)

> **Phase D is a fast-follow — it is NOT a cutover blocker.** Run this after
> the cutover gate is complete and DNS points to the Go service. See
> METHODOLOGY.md §1 for why the protocol is pinned before running.

---

## Prerequisites (complete ALL before issuing any k6 command)

1. **Matched hardware provisioned.** Two `t3.small` instances in the same VPC:
   - `tfbindingandperturbation.com` — Go service running (cutover already complete).
   - `legacy.tfbindingandperturbation.com` — legacy Shiny running.
   Both must use the **same `tfbp.duckdb` artifact** (same sha256).

2. **k6 off-box.** The load generator must NOT run on either target. Confirm:
   ```bash
   mpstat 5   # on the off-box k6 host — must stay < 70% during the run
   ```

3. **Frame capture complete.** `frames.js.__CAPTURED__ === true` with all four
   slots filled. If not, follow `CAPTURE.md` first. The Shiny arm will refuse
   to run with empty frames.

4. **Credit accrual.** Restart both containers and let both hosts idle for
   5 minutes before starting the ladder (prevents burstable CPU-credit drain
   from contaminating the first steps).

5. **Confirm `ARTIFACT_KIND=real`.** Both arms must use real data, not the
   test fixture.

---

## Step 1 — warm run (Go arm)

```bash
# On the off-box k6 host, from the repo root:
RATES=5,40,80 STEP_HOLD=4m RAMP=30s \
  ARTIFACT_KIND=real WARM=1 \
  BASE_URL=https://tfbindingandperturbation.com \
  k6 run \
    -e RATES=$RATES -e STEP_HOLD=$STEP_HOLD -e RAMP=$RAMP \
    -e ARTIFACT_KIND=$ARTIFACT_KIND -e WARM=$WARM \
    -e BASE_URL=$BASE_URL \
    --out json=go_warm.json \
    tests/loadtest/k6/scenarios/arrival_slo.js
```

Record the `=== SLO VERDICT ===` block from stdout and fill in the Go warm row
of the crossover table in `tests/loadtest-summary.md`.

---

## Step 2 — cold run (Go arm)

```bash
# Restart the Go container to empty the ristretto cache:
ssh <go-host> "docker compose restart tfbp"

# Immediately start the cold ladder (no pre-warm):
ARTIFACT_KIND=real \
  BASE_URL=https://tfbindingandperturbation.com \
  k6 run \
    -e ARTIFACT_KIND=$ARTIFACT_KIND \
    -e BASE_URL=$BASE_URL \
    --out json=go_cold.json \
    tests/loadtest/k6/scenarios/arrival_slo.js
```

Record the cold p95 and fill in the Go cold row.

---

## Step 3 — warm run (Shiny arm)

```bash
# Ensure the legacy Shiny process is alive (not restarted):
curl -s https://legacy.tfbindingandperturbation.com/ | head -1

# Run the Shiny ladder:
RATES=5,40,80 STEP_HOLD=4m RAMP=30s \
  ARTIFACT_KIND=real \
  BASE_URL=https://legacy.tfbindingandperturbation.com \
  SHINY_ACTION_TIMEOUT=30000 \
  k6 run \
    -e RATES=$RATES -e STEP_HOLD=$STEP_HOLD -e RAMP=$RAMP \
    -e ARTIFACT_KIND=$ARTIFACT_KIND \
    -e BASE_URL=$BASE_URL \
    -e SHINY_ACTION_TIMEOUT=$SHINY_ACTION_TIMEOUT \
    --out json=shiny_warm.json \
    tests/loadtest/k6/headtohead/shiny_k6.js
```

Record the `=== SHINY SLO VERDICT ===` block and fill in the Shiny warm row.

---

## Step 4 — cold run (Shiny arm)

```bash
# Restart the Shiny process to clear any in-memory state:
ssh <shiny-host> "docker compose restart shiny"

# Immediately start the cold ladder:
ARTIFACT_KIND=real \
  BASE_URL=https://legacy.tfbindingandperturbation.com \
  SHINY_ACTION_TIMEOUT=30000 \
  k6 run \
    -e ARTIFACT_KIND=$ARTIFACT_KIND \
    -e BASE_URL=$BASE_URL \
    -e SHINY_ACTION_TIMEOUT=$SHINY_ACTION_TIMEOUT \
    --out json=shiny_cold.json \
    tests/loadtest/k6/headtohead/shiny_k6.js
```

Record the cold `shiny_action_ms` p95 and fill in the Shiny cold row.

---

## Step 5 — fill in the crossover table

Open `tests/loadtest-summary.md` and fill in all `<FILL IN>` cells in the
"Head-to-head vs legacy Python Shiny (G3)" section. For each arm:

- **Highest req/s at SLO**: the highest rate step at which
  `dropped_iterations == 0` AND the availability + latency SLOs both hold
  (see METHODOLOGY.md §7). Typically this is the last step where both gates
  are green before either `shiny_action_ok` drops below 0.995 or p99 exceeds
  500 ms.
- **Degradation rate**: the first rate step where the SLO breaks.
- **Degradation mode**: one of:
  - `timeout-cascade` — `shiny_action_ms` p99 climbs, `shiny_action_ok` drops as timeouts exceed `SHINY_ACTION_TIMEOUT`.
  - `session-churn` — `shiny_reconnects_total` climbs sharply; Shiny kills sessions under load.
  - `queue-then-504` — similar to the Go arm's pool-saturation mode.
  - `OOM` — Shiny process OOM-killed (check `dmesg` on the Shiny host).
  - `credit-throttle` — CPU-credit exhaustion (healthy RSS, climbs with flat pool).

**Pass criterion check (METHODOLOGY.md §7):**
If Go's highest req/s at SLO (warm) > Shiny's degradation rate (warm), G3 = PASS.

---

## Step 6 — run validity checks

Before declaring any result:

```bash
# Check dropped_iterations == 0 on both arms (invalid if > 0).
jq '.metrics.dropped_iterations.values.count' go_warm.json
jq '.metrics.dropped_iterations.values.count' shiny_warm.json

# Check k6 host CPU did not exceed 70% (mpstat log from the run window).
```

If `dropped_iterations > 0` on either arm, the offered rate is a lie.
Recalibrate (`MAX_VUS`, or shard k6) and rerun. Do not record the result.

---

## Step 7 — commit

```bash
git add tests/loadtest-summary.md
git commit -m "docs(headtohead): record Phase D G3 crossover results for <date>"
```

---

## Makefile convenience targets

```bash
# Go arm warm run (matches arrival_slo.js defaults + WARM=1):
make loadtest-headtohead-go WARM=1

# Go arm cold run:
make loadtest-headtohead-go

# Shiny arm warm run:
make loadtest-headtohead-shiny

# Both arms (warm, then cold — sequential, run on the same off-box host):
make loadtest-headtohead
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| `OPERATIONAL PREREQUISITE NOT MET: frames.js __CAPTURED__ is false` | Frame capture not done | Follow `CAPTURE.md` |
| `shiny_action_ok` rate == 0 from the first step | Wrong `wsPath` or broken init frames | Re-capture; run single-VU verification from `CAPTURE.md` §Verification |
| `shiny_reconnects_total` climbs at low rates | Session idle timeout set too short on the Shiny host | Increase `SESSION_TIMEOUT` in the Shiny config; not a test artifact |
| `dropped_iterations > 0` on either arm | k6 host CPU > 70% OR `MAX_VUS` too low | Add `-e MAX_VUS=600` or shard k6 |
| Go arm shows FAIL but Shiny passes | Unusual — check that both are pointed at the same artifact sha256 | Verify with `curl /api/version` on both hosts |
