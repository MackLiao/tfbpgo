# Instance role: read the one artifact from S3 + SSM Session Manager access.
# No static AWS keys land on the box — the init container's aws-cli picks up
# these role credentials from IMDS automatically.
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "demo" {
  name               = "${var.project_name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

# Least privilege: GetObject on the artifact prefix only.
data "aws_iam_policy_document" "artifact_read" {
  statement {
    sid       = "ReadTfbpArtifacts"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${var.artifact_bucket}/tfbp/*"]
  }
}

resource "aws_iam_role_policy" "artifact_read" {
  name   = "artifact-read"
  role   = aws_iam_role.demo.id
  policy = data.aws_iam_policy_document.artifact_read.json
}

# Session Manager (terminal access without an open SSH port).
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.demo.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "demo" {
  name = "${var.project_name}-profile"
  role = aws_iam_role.demo.name
}
