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
  description = "Root volume size. The ~3GB artifact plus a transient .new copy during refresh plus DuckDB spill need headroom."
  type        = number
  default     = 30
}

variable "repo_url" {
  description = "Git repo cloned onto the instance to fetch the demo compose file."
  type        = string
  default     = "https://github.com/BrentLab/tfbpshiny-go.git"
}

variable "repo_ref" {
  description = "Git ref (branch/tag) to clone."
  type        = string
  default     = "main"
}

variable "image_tag" {
  description = "GHCR image tag for the Go service (ghcr.io/brentlab/tfbpshiny-go:<tag>). The package must be PUBLIC or the instance pull will fail (no registry creds on the box by design)."
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
