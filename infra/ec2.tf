# Allocate the EIP first (standalone) so its address is known before the
# instance's user_data is rendered — the nip.io host is derived from it.
resource "aws_eip" "demo" {
  domain = "vpc"
  tags   = { Name = "${var.project_name}-eip" }
}

resource "aws_instance" "demo" {
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.demo.id]
  iam_instance_profile   = aws_iam_instance_profile.demo.name

  # IMDSv2 required. hop_limit=2 is load-bearing: the aws-cli init container
  # runs one Docker network hop away from the host, so the default hop_limit
  # of 1 would block it from reaching IMDS for the instance-profile creds.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
  }

  user_data = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    nip_host        = local.nip_host
    expected_ip     = aws_eip.demo.public_ip
    image_repo      = var.image_repo
    image_tag       = var.image_tag
    artifact_bucket = var.artifact_bucket
    artifact_key    = var.artifact_key
    artifact_sha256 = var.artifact_sha256
    region          = var.region
    acme_email      = var.acme_email
    acme_ca_server  = var.acme_ca_server
    repo_url        = var.repo_url
    repo_ref        = var.repo_ref
  })

  # Re-provision if the bootstrap script or any value it bakes in changes.
  user_data_replace_on_change = true

  tags = { Name = "${var.project_name}" }
}

resource "aws_eip_association" "demo" {
  instance_id   = aws_instance.demo.id
  allocation_id = aws_eip.demo.id
}
