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
- Security hardening (IAM role, .env permissions)
- Artifact refresh
- Rollback
- Cutover gate checklist
- Legacy Shiny grace period (Task 13)
- Operating contract (single replica, schema upgrades)

---

## Operating contract (read first)

The Go service is designed to run as **exactly one replica** today.

- The `/api/v/{v}/*` middleware accepts only the artifact version currently
  loaded by the running binary. A mismatched `{v}` returns `410 Gone`. There
  is no acceptable-versions list. Multi-replica deploys with staggered
  artifact pushes would flap clients between replicas → don't run more than
  one tfbp container against the same Traefik route until this constraint
  is relaxed.
- During an artifact rollover, every open SPA tab will observe a brief
  window of `410 Gone` responses, then auto-reload. Clients reload at most
  twice (see `frontend/src/api/client.ts`); the third stale response surfaces
  an error rather than looping. Plan rollovers for low-traffic windows.
- The binary's compatible schema range is `[MinSchemaVersion,
  MaxSchemaVersion]` in `backend/internal/db/startup.go` — today both are
  `2`. When `schema_version=3` ships (post-cutover Phase 1.6), the migration
  path is:
  1. Ship a v=3-aware binary with `Min=2, Max=3` so it reads both. Roll
     the binary first.
  2. Publish + load the v=3 artifact. The binary picks it up.
  3. (Later) ship a v=3-only binary with `Min=3, Max=3` to drop the v=2
     path. This step is optional and only when v=2 is permanently retired.
  Updating only `TAG` while the artifact is still v=2, or only
  `ARTIFACT_KEY` while the binary is still v=2-only, refuses to start
  (see Rollback ▸ Bad image). The fail-fast is intentional.

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
docker compose --profile init up tfbp-data-init # one-shot; downloads + verifies
docker compose up -d                            # brings up tfbp + shinyapp (init is profile-gated, not re-run)

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
unchanged. It is gated behind the `init` Compose profile (see
`docker-compose.yml`), so `docker compose up -d` never re-runs it; you must
opt in explicitly via `docker compose --profile init up tfbp-data-init` when
refreshing the artifact.

## Security hardening

### Preferred: instance-profile IAM role (no static keys)

The `tfbp-data-init` container only needs to read the artifact from S3. The
cleanest way to grant that access is to attach an IAM **instance profile** to
the EC2 host and let the `amazon/aws-cli:2` image pick up the credentials
automatically via IMDSv2 — no static keys in `.env`, no rotation schedule.

1. **Create a role** named `tfbp-deploy` (or similar) with the following
   inline policy, scoped to the artifact prefix only:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "ReadTfbpArtifacts",
         "Effect": "Allow",
         "Action": ["s3:GetObject"],
         "Resource": ["arn:aws:s3:::brentlab-tfbp-artifacts/tfbp/*"]
       }
     ]
   }
   ```

2. **Attach the role** to the EC2 instance ("Actions → Security → Modify IAM
   role" in the console, or `aws ec2 associate-iam-instance-profile`).

3. **Remove the static keys** from the `tfbp-data-init` service in
   `docker-compose.yml`:

   ```yaml
   tfbp-data-init:
     # ...
     environment:
       AWS_REGION: ${AWS_REGION:-us-east-2}
       # AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY removed - role-based
       ARTIFACT_BUCKET: ${ARTIFACT_BUCKET}
       ARTIFACT_KEY: ${ARTIFACT_KEY}
       ARTIFACT_SHA256: ${ARTIFACT_SHA256}
   ```

   …and drop the matching `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
   lines from `.env`. The aws-cli image will reach IMDSv2 from inside the
   container automatically.

4. **Verify** with a dry-run `docker compose --profile init up tfbp-data-init`
   — it should authenticate and exit 0 without any AWS_* env vars set.

### Fallback: static keys in `.env`

If you cannot attach an instance role (e.g. the host is not EC2), keep the
static keys but harden the `.env` file:

```bash
chown <deploy-user>:<deploy-user> /opt/tfbp/.env
chmod 600 /opt/tfbp/.env
```

Schedule rotation of `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` every
**90 days**. The deploy IAM user should be scoped to `s3:GetObject` on
`arn:aws:s3:::${ARTIFACT_BUCKET}/tfbp/*` only (same policy as the role above)
— do not reuse a broader credential.

## Artifact refresh

Triggered either by the weekly cron in
`.github/workflows/artifact-publish.yml` (Sunday 05:00 UTC) or via the Actions
tab → "Run workflow". The workflow uploads the new `tfbp.duckdb` to S3 and
publishes a `deploy/artifact-manifest.<date>.json` containing the new key +
sha256.

> **A manifest-semantic fix REQUIRES an artifact rebuild — it is NOT delivered
> by a binary upgrade alone.** Some fixes change how `data_prep` *generates* the
> manifest tables baked into `tfbp.duckdb` (e.g. emitting `sample_id_field =
> "sample_id"` instead of the YAML source name `gm_id`; replacing the
> space-containing `"Experimental condition"` column with `condition` in
> `condition_cols` / `default_filters`). The running Go binary reads the
> **baked** manifest, so a `tfbp.duckdb` built *before* such a fix still carries
> the old values. Symptoms against a stale artifact:
>
> - a stale `condition_cols="Experimental condition"` **fail-fasts at startup**
>   (`NewWhitelist` rejects the space via `SafeIdentRE`) — `/readyz` never goes
>   green, so the deploy is blocked loudly; and
> - a stale `sample_id_field="gm_id"` passes startup (it is a valid identifier)
>   but **500s at request time** on `/datasets/{db}/sample-conditions` and
>   `/selection/matrix` because the materialized `{db}_meta` no longer has that
>   column.
>
> `schema_version` does NOT change for a content-only manifest fix, so the
> startup schema gate cannot distinguish a fixed artifact from a stale one.
> After deploying any commit that touches `data_prep/src/data_prep/manifests.py`
> semantics, **rebuild + republish the artifact** (steps below) and confirm the
> `startup_ok` log line's `built_at` postdates the fix.

```bash
# On the host, after CI is green:
cd /opt/tfbp
# Download the artifact-manifest JSON the workflow produced (Actions artifact),
# read the new ARTIFACT_KEY + ARTIFACT_SHA256, and update .env:
sed -i "s|^ARTIFACT_KEY=.*|ARTIFACT_KEY=tfbp/YYYY-MM-DD/tfbp.duckdb|" .env
sed -i "s|^ARTIFACT_SHA256=.*|ARTIFACT_SHA256=<new-hex>|"             .env

# Run init container (opt-in via profile); it overwrites the named volume.
docker compose --profile init up tfbp-data-init  # exits 0 on success
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
docker compose --profile init up tfbp-data-init
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
   - Pool contention: `rate(db_pool_wait_duration_seconds_total[5m]) /
     rate(db_pool_wait_count_total[5m])` < 0.05 (mean wait per acquire
     below 50 ms). The legacy `db_pool_wait_duration_seconds` histogram
     observes per-5s-tick MEAN wait and its quantiles are NOT per-acquire
     p95 — alert on the counter pair instead.
   - 0 OOM kills (`dmesg | grep -i killed`)

3. **Cold-burst gate** — restart the container so the cache is empty, then run
   `tests/loadtest/k6/cold_burst.js` (100 VUs / single uncached URL / 500 ms).
   Gates from `/metrics` deltas printed by the script's `teardown`:
   - `singleflight_shared_calls_total` increased by ≥ 99
   - `db_query_duration_seconds_count{endpoint="binding/data"}` increased by exactly 1
   - `cache_misses_total` for the burst URL increased by exactly 1
   - `cache_hits_total` for the burst URL did **not** increase
     (singleflight waiters bypass the ristretto-hit path; the loader
     populates the cache exactly once at the end of the burst)

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
