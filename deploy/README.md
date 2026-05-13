# Production deploy — runbook

Operational guide for cutting `tfbindingandperturbation.com` over to the Go +
React service and keeping it healthy. See
`docs/superpowers/specs/2026-05-12-go-react-rewrite-design.md` §9 for the
authoritative spec; this file is the on-host cheat sheet.

The Go service runs as a single container behind the existing Traefik instance.
A one-shot init container downloads + verifies `tfbp.duckdb` from S3 into a
named volume that the runtime mounts read-only. The legacy Shiny app stays up
on `legacy.tfbindingandperturbation.com` for a 30-day grace period.

## Contents

- One-time host setup
- Routine deploy
- Artifact refresh
- Rollback
- Cutover gate checklist
- Legacy Shiny grace period (Task 13)

---

## One-time host setup

Run once on the EC2 host (`tfbindingandperturbation.com`):

```bash
# 1. Clone the repo into the deploy dir.
sudo mkdir -p /opt/tfbp && sudo chown "$USER:$USER" /opt/tfbp
git clone https://github.com/BrentLab/tfbpshiny-go.git /opt/tfbp
cd /opt/tfbp

# 2. Make sure Traefik's shared docker network exists.
docker network create web 2>/dev/null || true

# 3. Copy and fill in .env.
cp .env.example .env
# Edit .env:
#   TAG=<latest image tag, e.g. v1.0.0>
#   LEGACY_TAG=<pre-cutover Shiny image tag>
#   ARTIFACT_BUCKET=brentlab-tfbp-artifacts
#   ARTIFACT_KEY=tfbp/YYYY-MM-DD/tfbp.duckdb
#   ARTIFACT_SHA256=<64-char hex from `deploy/artifact-manifest.<date>.json`>
#   AWS_REGION=us-east-2
#   AWS_ACCESS_KEY_ID=<deploy IAM user>
#   AWS_SECRET_ACCESS_KEY=<deploy IAM user>
#   HF_TOKEN=<only needed by legacy shinyapp>

# 4. Pull images, download the artifact, start the stack.
docker compose pull
docker compose up tfbp-data-init                # one-shot; downloads + verifies
docker compose up -d tfbp shinyapp

# 5. Smoke.
curl -sf https://tfbindingandperturbation.com/healthz
curl -sf https://tfbindingandperturbation.com/readyz
curl -sf https://tfbindingandperturbation.com/api/version | jq .
```

Traefik must already be configured to terminate TLS on the `web` network with a
`letsencrypt` cert resolver; the `docker-compose.yml` here adds router labels
only, not the Traefik instance itself. See `reference/compose/production/` for
the existing Traefik config that this stack plugs into.

## Routine deploy

Every new release of the Go binary follows the same path: tag in GitHub → CI
builds the image → SSH and bump `TAG`.

```bash
# Local: cut a tag.
git tag -a v1.X.Y -m "release v1.X.Y: ..." && git push origin v1.X.Y
# `.github/workflows/image-publish.yml` builds + pushes
# ghcr.io/brentlab/tfbpshiny-go:v1.X.Y. Wait for the green check.

# On the host:
cd /opt/tfbp
git pull                                         # picks up new compose / .env.example changes
sed -i "s/^TAG=.*/TAG=v1.X.Y/" .env              # or edit by hand
docker compose pull tfbp
docker compose up -d tfbp

# Verify.
docker compose logs --tail=50 tfbp | grep -i 'listening\|artifact_version'
curl -sf https://tfbindingandperturbation.com/api/version | jq .
```

`tfbp-data-init` does **not** re-run on a routine deploy — the artifact is
unchanged. Skip it explicitly with `docker compose up -d tfbp` (do not pass
`--scale` or use `docker compose up -d` without a service arg, since that
would re-run the init container against the current `.env`).

## Artifact refresh

Triggered either by the weekly cron in
`.github/workflows/artifact-publish.yml` (Sunday 05:00 UTC) or via the Actions
tab → "Run workflow". The workflow uploads the new `tfbp.duckdb` to S3 and
publishes a `deploy/artifact-manifest.<date>.json` containing the new key +
sha256.

```bash
# On the host, after CI is green:
cd /opt/tfbp
# Download the artifact-manifest JSON the workflow produced (Actions artifact),
# read the new ARTIFACT_KEY + ARTIFACT_SHA256, and update .env:
sed -i "s|^ARTIFACT_KEY=.*|ARTIFACT_KEY=tfbp/YYYY-MM-DD/tfbp.duckdb|" .env
sed -i "s|^ARTIFACT_SHA256=.*|ARTIFACT_SHA256=<new-hex>|"             .env

# Run init container; it overwrites the named volume.
docker compose up tfbp-data-init                 # exits 0 on success
# Restart so the running binary reopens the file and re-reads artifact_manifest.
docker compose restart tfbp
curl -sf https://tfbindingandperturbation.com/api/version | jq .artifactVersion
```

The Go binary's startup contract (§9.5) gates on `schema_version` and the
canary `SELECT`, so a broken artifact fails the restart immediately — the old
container stays up via the previous image's running process is **already
stopped** by `restart`, so verify `/readyz` returns 200 before walking away.

## Rollback

### Bad image (Go binary regression)

```bash
cd /opt/tfbp
sed -i "s/^TAG=.*/TAG=<previous-good-tag>/" .env
docker compose pull tfbp
docker compose up -d tfbp
curl -sf https://tfbindingandperturbation.com/readyz
```

### Bad artifact (data regression)

```bash
cd /opt/tfbp
sed -i "s|^ARTIFACT_KEY=.*|ARTIFACT_KEY=<previous-good-key>|" .env
sed -i "s|^ARTIFACT_SHA256=.*|ARTIFACT_SHA256=<previous-good-sha>|" .env
docker compose up tfbp-data-init
docker compose restart tfbp
```

Both rollback paths are safe to run together; the binary refuses to start if
the image's `schema_version` range doesn't cover the artifact's
`schema_version`.

## Cutover gate checklist

Before pointing DNS at the Go service, every line below must be **green**.
Numbers go into `tests/loadtest-summary.md` (template lives there). Spec
§11.3 is the authoritative source — this list mirrors it.

1. **Parity** — `make parity` returns 0 diffs against committed snapshots
   (`tests/parity/snapshots/`). The fixture has been widened (Phase 3 Task 2)
   so all 11 golden URLs in `tests/parity/golden_urls.txt` pass.

2. **Warm-cache load test** — run `tests/loadtest/k6/profile.js` (50 VUs, 10
   min) after pre-warming the popular-regulator subset. Gates:
   - `http_req_duration` p95 < 200 ms, p99 < 500 ms
   - `http_req_failed` rate == 0
   - Peak RSS < 1.5 GB
   - `cache_hit_ratio` (popular segment) > 0.85
   - `db_pool_wait_duration_seconds` p95 < 100 ms
   - 0 OOM kills (`dmesg | grep -i killed`)

3. **Cold-burst gate** — restart the container so the cache is empty, then run
   `tests/loadtest/k6/cold_burst.js` (100 VUs / single uncached URL / 500 ms).
   Gates from `/metrics` deltas printed by the script's `teardown`:
   - `singleflight_shared_calls_total` increased by ≥ 99
   - `db_query_duration_seconds_count{endpoint="binding/data"}` increased by exactly 1
   - `cache_misses_total` for the burst URL increased by exactly 1
   - `cache_hits_total` for the burst URL increased by ≈ 99

4. **OWASP-ish security spot-check** — see `backend/internal/api/*_test.go`
   and the security review notes in `docs/superpowers/`. On the live host:
   - Bogus identifier (`?datasets=xyz%27;DROP--`) returns 400, not 500.
   - Stale `/api/v/{old}/datasets` returns 410 with `Location: /api/version`.
   - Non-GET to `/api/*` returns 405.
   - `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`
     headers present on SPA HTML response.
   - `/metrics` and `/_ref` (gated by `ENABLE_REFERENCE_VIEWS`, off in prod)
     are unreachable externally if the spec calls for it (currently `/metrics`
     is exposed; document any Traefik-level ACL applied here).

5. **Observability** — see the checklist in `tests/loadtest-summary.md` §"Observability checklist".

6. **Record + commit** — fill in `tests/loadtest-summary.md` with the actual
   numbers, commit it on `main`, and push **before** flipping DNS.

7. **Flip DNS** — point `tfbindingandperturbation.com` at the EC2 host (if
   not already), and add the `legacy.` record per the next section.

## Legacy Shiny grace period (Task 13)

The legacy Python Shiny app keeps running for 30 days on a `legacy.` subdomain
so external users have a graceful fallback. Routing is already wired in
`docker-compose.yml` — only DNS and a calendar reminder need to happen
operationally.

1. **DNS** — at the registrar (or Route 53), add:
   ```
   legacy.tfbindingandperturbation.com   A      <same EC2 elastic IP>
   # or, if using a CNAME stack:
   legacy.tfbindingandperturbation.com   CNAME  <ALB / EC2 DNS>
   ```
   Wait for propagation (`dig +short legacy.tfbindingandperturbation.com`).

2. **Verify Traefik resolves both rules.** Smoke-test from a workstation
   outside the host:
   ```bash
   curl -sI https://tfbindingandperturbation.com/api/version
   #   → HTTP/2 200, served by the Go container (look for X-Powered-By or
   #     the JSON shape; check `docker compose logs tfbp` for the request).

   curl -sI https://legacy.tfbindingandperturbation.com/
   #   → HTTP/2 200, served by the shinyapp container; check
   #     `docker compose logs shinyapp` for the request.
   ```
   If either returns 404 or routes to the wrong container, double-check the
   Traefik labels in `docker-compose.yml` and the certificate resolver name
   matches the running Traefik's `--certificatesresolvers.<name>` config.

3. **Calendar reminder — 30 days from cutover.** Add a calendar event titled
   "tfbp: remove legacy Shiny service" set to **cutover-date + 30 days**.
   When it fires:
   ```bash
   cd /opt/tfbp
   docker compose stop shinyapp
   docker compose rm -f shinyapp
   # Then, in the repo:
   #   - delete the `shinyapp` service block from docker-compose.yml
   #   - delete the `LEGACY_TAG` and `HF_TOKEN` lines from .env.example
   #   - delete the `legacy.tfbindingandperturbation.com` DNS record
   git commit -am "chore(deploy): remove legacy Shiny service after 30-day grace"
   ```

---

## Files referenced from this runbook

- `/opt/tfbp/docker-compose.yml` — service definitions + Traefik labels (repo: `docker-compose.yml`).
- `/opt/tfbp/.env` — TAG, ARTIFACT_KEY, ARTIFACT_SHA256, AWS creds (repo: `.env.example`).
- `tests/loadtest/k6/profile.js`, `tests/loadtest/k6/cold_burst.js` — k6 acceptance scripts.
- `tests/loadtest-summary.md` — cutover gate template; operator fills it in and commits.
- `deploy/s3-upload.sh` — manual artifact publish helper (CI usually runs this).
- `.github/workflows/image-publish.yml`, `.github/workflows/artifact-publish.yml` — CI.
