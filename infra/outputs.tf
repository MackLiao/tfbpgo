output "demo_url" {
  description = "Send this to the PI. TLS cert is issued by Let's Encrypt on first request (allow ~30s after boot)."
  value       = "https://${local.nip_host}"
}

output "public_ip" {
  description = "Elastic IP of the demo instance."
  value       = aws_eip.demo.public_ip
}

output "instance_id" {
  value = aws_instance.demo.id
}

output "ssm_session_command" {
  description = "Open a shell on the box (no SSH). Requires the AWS CLI Session Manager plugin."
  value       = "aws ssm start-session --target ${aws_instance.demo.id} --region ${var.region}"
}

output "tail_bootstrap_log" {
  description = "Watch cloud-init finish, then smoke /readyz."
  value       = "aws ssm start-session --target ${aws_instance.demo.id} --region ${var.region} --document-name AWS-StartInteractiveCommand --parameters command='sudo tail -f /var/log/cloud-init-output.log'"
}

output "start_if_stopped" {
  description = "Restart the box if the idle-stop cost guard stopped it (same URL, containers auto-restart)."
  value       = "aws ec2 start-instances --instance-ids ${aws_instance.demo.id} --region ${var.region}"
}
