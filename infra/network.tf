# Public HTTP/HTTPS only. No SSH (22) — administer via SSM Session Manager,
# which works over the instance's outbound 443 to AWS, needing no ingress.
resource "aws_security_group" "demo" {
  name        = "${var.project_name}-sg"
  description = "tfbp demo: public 80/443 in, all out, no SSH"
  vpc_id      = aws_vpc.demo.id

  ingress {
    description = "HTTP (ACME HTTP-01 challenge + redirect to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS (the demo link)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "All outbound (S3 artifact, GHCR pull, ACME, SSM)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
