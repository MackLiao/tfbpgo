# Demo deploy — prove the Go service under concurrency

A **throwaway** single-instance deploy to hand a PI a live HTTPS link plus
k6 load numbers. Not the production cutover — see `../README.md` for that.

What Terraform stands up (`../../infra/`):

- 1× `t3.small` EC2 (us-east-2, amd64, 30GB gp3, IMDSv2) with an Elastic IP
- An IAM instance profile that can read the artifact from S3 (no static keys)
- Security group: public 80/443 only, no SSH (admin via SSM Session Manager)
- cloud-init that installs Docker, clones this repo, and brings up
  `docker-compose.demo.yml`: its own Traefik (Let's Encrypt via **nip.io**) +
  the Go service. No legacy Shiny, so the box's full 2GB backs one service.

The link looks like `https://tfbp-demo.<elastic-ip>.nip.io`.

---

## Prerequisites (on your laptop)

- **Terraform ≥ 1.6**, **AWS CLI** with credentials for the target account
  (`aws sts get-caller-identity` works), and the **Session Manager plugin**
  (for shell access; optional).
- **Docker + Python/poetry** to build the artifact, and `HF_TOKEN` in the
  repo-root `.env` (you confirmed it's there).
- The Go image published to **GHCR as a public package** (see step 1).
- The deploy identity needs enough IAM permissions to create the stack — see
  **Credentials & IAM** below. Terraform reads your ambient AWS creds
  (`AWS_PROFILE` / `~/.aws/credentials` / SSO); you never paste keys anywhere.

## Credentials & IAM

`terraform` authenticates as whatever identity your shell already has — there's
no token to hand off. Confirm with `aws sts get-caller-identity`. To use a
different identity, `export AWS_PROFILE=<name>` before running terraform.

That identity needs create/destroy rights on EC2 + EIP + a security group + a
CloudWatch alarm + the instance IAM role/profile (including `iam:PassRole`).
`infra/deploy-iam-policy.example.json` is a ready-to-attach least-privilege
policy (replace the account id). Quickest path for a throwaway demo is to run
the apply from an admin/PowerUser session and attach that policy for the IAM
bits; the **runtime** security is unaffected either way — the instance's own
role (`infra/iam.tf`) stays scoped to `s3:GetObject` on the artifact only.

## Cost

| Item | ~Cost (us-east-2) |
|------|-------------------|
| t3.small, running 24/7 | ~$15/mo ($0.0208/hr) |
| gp3 root, 20 GB | ~$1.60/mo |
| Elastic IP (in-use) | ~$3.60/mo |
| Data transfer (light demo + a few k6 runs) | within the 100 GB/mo free egress |

The instance type is deliberately **t3.small to match production**, so the
concurrency numbers transfer — don't shrink it or the proof is meaningless.
Two guards keep the bill down:

- **Auto-stop when idle** (`idle_stop_hours`, default 6): a CloudWatch alarm
  stops the box after 6h of <2% CPU, so a forgotten demo stops billing compute.
  Browsing or a k6 run keeps it up. Restart with the `start_if_stopped` output
  command — same URL, the artifact and containers come right back.
- **`terraform destroy`** when the PI is done — removes everything (the S3
  artifact, shared with prod, is untouched).

> Cheaper option, not enabled: `t4g.small` (Graviton) is ~20% less, but needs
> an arm64 image build (current image is amd64-only). Ask if you want that.

---

## Step 0 — Build + publish the real artifact to S3

The instance downloads `tfbp.duckdb` from S3 at boot; build and upload it first.

```bash
cd data_prep && poetry install -E full
make data-build                       # reads HF_TOKEN; ~5–10 min; writes ../tfbp.duckdb
cd ..
ARTIFACT_BUCKET=brentlab-tfbp-artifacts deploy/s3-upload.sh
#  → prints ARTIFACT_KEY (e.g. tfbp/2026-06-10/tfbp.duckdb) and ARTIFACT_SHA256.
#    Copy both into infra/terraform.tfvars in step 2.
```

The publish path uses your laptop's AWS creds. The *instance* never gets keys —
its IAM role reads `s3://brentlab-tfbp-artifacts/tfbp/*`.

## Step 1 — Make sure the Go image is in GHCR (public)

Cut a tag so `.github/workflows/image-publish.yml` builds and pushes it to
`ghcr.io/mackliao/tfbpgo` (the workflow targets this fork):

```bash
git tag -a v0.0.1-demo -m "demo build" && git push origin v0.0.1-demo
# wait for the green check, then on GitHub: repo → Packages → tfbpgo
# → Package settings → Change visibility → Public.
```

Set `image_tag` in tfvars to whatever you pushed (`image_repo` already defaults
to `ghcr.io/mackliao/tfbpgo`). The instance has no registry credentials by
design, so the package **must be public** (alternative: switch `infra/` to a
private ECR repo + role pull — ask if you want that instead).

## Step 1.5 — Push this scaffold (required)

cloud-init **clones the repo from GitHub** to get `docker-compose.demo.yml` —
it does not copy your local working tree. So `infra/` and `deploy/demo/` must
exist on the ref you set as `repo_ref`. Commit and push them first:

```bash
git add infra deploy/demo .gitignore && git commit -m "chore: demo deploy infra"
git push origin <your-branch-or-main>
# set repo_ref in terraform.tfvars to whatever you pushed (default: main)
```

## Step 2 — Configure and apply Terraform

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars: image_tag, artifact_key, artifact_sha256, acme_email, repo_ref.
terraform init
terraform plan            # review — nothing is created until apply

# Recommended: a STAGING dry-run first so a misconfig doesn't burn nip.io's
# shared Let's Encrypt rate limit (nip.io hits "too many certificates" often).
terraform apply -var 'acme_ca_server=https://acme-staging-v02.api.letsencrypt.org/directory'
#   → verify /readyz is green and a *staging* cert appears (browser will warn —
#     that's expected for staging). Then switch to the real cert:
terraform apply           # production CA (default); replaces the instance
```

Outputs include `demo_url`, `public_ip`, and an `ssm_session_command`.

> If the production cert won't issue (nip.io rate-limited), your options are:
> wait an hour and retry, use `sslip.io` instead (same idea, different shared
> pool — change the host suffix in `main.tf`), or point a cheap real domain at
> the EIP. The plain `http://<public_ip>` always works as a last resort.

## Step 3 — Wait for boot, then smoke

cloud-init pulls images and downloads the 3GB artifact, so give it a few
minutes. Watch it (needs the SSM plugin):

```bash
eval "$(terraform output -raw tail_bootstrap_log)"   # Ctrl-C when you see "bootstrap complete"
```

Then from anywhere:

```bash
URL=$(terraform output -raw demo_url)
curl -sf "$URL/readyz" && echo                       # {"ready":true}
curl -sf "$URL/api/version" | jq .                   # confirms the real artifact loaded
open "$URL"                                           # the SPA — click around
```

First HTTPS hit triggers the Let's Encrypt cert (~10–30s one-time stall).

## Step 4 — Load test for the numbers

Point the existing k6 scripts at the demo URL. Run from a machine with good
bandwidth — ideally a second cloud box in us-east-2, not hotel wifi, so the
client isn't the bottleneck.

```bash
cd tests/loadtest/k6
URL=$(cd ../../../infra && terraform output -raw demo_url)

# Warm-cache profile: 50 VUs for 10 min (the headline "handles concurrency" run).
k6 run -e BASE_URL="$URL" profile.js

# Cold-burst: singleflight coalescing under a synchronized miss.
k6 run -e BASE_URL="$URL" cold_burst.js
```

Capture k6's end-of-run summary (req/s, p95/p99, error rate, checks).
`tests/loadtest-summary.md` is the template to drop the numbers into. For a
PI, the one-liner that lands is **"sustained N req/s at p95 < X ms with 0
errors on a $15/mo instance, where the old Shiny app served ~M."**

## Step 5 — Send the link

```bash
cd infra && terraform output -raw demo_url
```

## Step 6 — Tear down (don't leave it running)

```bash
cd infra && terraform destroy
```

This removes the instance, EIP, IAM role, and SG. It does **not** touch the S3
artifact (shared with production). A running `t3.small` + EIP is ~$15/mo, so
destroy when the PI's seen it.

---

## Notes & caveats

- **Single replica only.** The `/api/v/{v}` contract returns 410 for a
  mismatched artifact version, so never scale this to >1 tfbp container behind
  the same route (same constraint as production — `../README.md`).
- **nip.io** is a free public DNS reflector. Fine for a demo; don't use it for
  anything you'd keep. If it's ever down, fall back to `https://<ip>` (cert
  will warn) or buy a real domain.
- **Honest comparison:** the demo uses the same `t3.small`, `mem_limit=1.6g`,
  `threads=1`, 2-conn pool, and real artifact as production — so the numbers
  transfer. To literally show old-vs-new, also run the legacy Shiny app on a
  second instance and use the `loadtest-headtohead-*` make targets.
- **Cost:** ~$0.02/hr instance + EIP. Negligible for a few days; just remember
  step 6.
