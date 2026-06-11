variable "region" {
  description = "AWS region. us-east-2 (Ohio) is the closest region to Missouri and matches the repo's existing defaults."
  type        = string
  default     = "us-east-2"
}

variable "project_name" {
  description = "Name prefix for tagged resources."
  type        = string
  default     = "tfbp-demo"
}

variable "instance_type" {
  description = "EC2 instance type. t3.small mirrors the production target so the concurrency numbers are honest."
  type        = string
  default     = "t3.small"
}

variable "root_volume_gb" {
  description = "Root volume size (GiB). 20 is plenty for the demo: ~3GB artifact + images + up to 2GB DuckDB spill, with headroom. Production wants 30 for the 2x-artifact refresh window, but the demo never refreshes."
  type        = number
  default     = 20
}

variable "idle_stop_hours" {
  description = "Cost guard: auto-stop the instance after this many consecutive hours of <2% CPU, so a forgotten demo stops billing compute. A k6 load test pegs CPU, so it won't trip mid-demo. Set 0 to disable. Restart with `aws ec2 start-instances` (the EIP + artifact persist; containers auto-restart)."
  type        = number
  default     = 6
}

variable "repo_url" {
  description = "Git repo cloud-init clones to fetch deploy/demo/. Must be public (no creds on the box) and contain this scaffold on `repo_ref`."
  type        = string
  default     = "https://github.com/MackLiao/tfbpgo.git"
}

variable "repo_ref" {
  description = "Git ref (branch/tag) to clone."
  type        = string
  default     = "main"
}

variable "image_repo" {
  description = "GHCR image repo for the Go service, WITHOUT the tag. A fork publishing via its own CI should set this to ghcr.io/<owner>/<repo> (e.g. ghcr.io/mackliao/tfbpgo). The package must be PUBLIC — there are no registry creds on the box by design."
  type        = string
  default     = "ghcr.io/brentlab/tfbpshiny-go"
}

variable "image_tag" {
  description = "Image tag for the Go service (paired with image_repo). Must be a tag your image-publish workflow has pushed."
  type        = string
}

variable "artifact_bucket" {
  description = "S3 bucket holding the published tfbp.duckdb artifact."
  type        = string
  default     = "brentlab-tfbp-artifacts"
}

variable "artifact_key" {
  description = "S3 key of the artifact, e.g. tfbp/2026-06-10/tfbp.duckdb. Printed by deploy/s3-upload.sh."
  type        = string
}

variable "artifact_sha256" {
  description = "Expected sha256 of the artifact (64 hex chars). Printed by deploy/s3-upload.sh; the init container verifies it."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.artifact_sha256))
    error_message = "artifact_sha256 must be 64 lowercase hex characters."
  }
}

variable "acme_email" {
  description = "Email Let's Encrypt associates with the demo cert (expiry notices)."
  type        = string
}

variable "acme_ca_server" {
  description = <<-EOT
    ACME directory URL. Default is Let's Encrypt PRODUCTION. nip.io is a shared
    domain that frequently hits LE's per-registered-domain rate limit, so do a
    dry-run first with the STAGING URL
    (https://acme-staging-v02.api.letsencrypt.org/directory) to validate the
    whole pipeline without spending a production slot, then switch back.
  EOT
  type        = string
  default     = "https://acme-v02.api.letsencrypt.org/directory"
}
