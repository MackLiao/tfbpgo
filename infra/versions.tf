# Demo-only infra for proving the Go service's concurrency under load.
# Single throwaway EC2 instance behind its own Traefik (Let's Encrypt + nip.io).
# NOT the production cutover stack — see deploy/README.md for that.
#
# State is local (terraform.tfstate in this dir). That's fine for a throwaway
# demo a single operator runs and destroys. For anything longer-lived, switch
# to an S3 backend with use_lockfile=true.
terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
      Lifecycle = "demo-throwaway"
    }
  }
}
