# Latest Amazon Linux 2023 AMI (x86_64 — the Go image is single-arch amd64).
# AL2023 ships the SSM agent preinstalled, so we get Session Manager access
# with no SSH port open.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

# Default VPC + its subnets — enough for a single public demo instance.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

locals {
  # nip.io resolves <anything>.<ip-with-dashes>.nip.io -> <ip>, giving us a
  # real hostname for a Let's Encrypt cert without buying/managing DNS.
  nip_host = "tfbp-demo.${replace(aws_eip.demo.public_ip, ".", "-")}.nip.io"
}
