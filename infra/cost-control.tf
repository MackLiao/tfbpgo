# Cost guard for a throwaway demo: stop the instance after a sustained idle
# window so a forgotten box stops billing compute (~$0.0208/hr for t3.small).
#
# The `arn:aws:automate:<region>:ec2:stop` action is a built-in CloudWatch->EC2
# action — it needs no IAM role. A stopped instance keeps its EBS volume, its
# Elastic IP association, and (via restart: unless-stopped) its containers, so
# `aws ec2 start-instances` brings the exact demo back, same URL. The artifact
# lives on the EBS-backed Docker volume, so it survives stop/start.
#
# Threshold is <2% CPU averaged over 1h for `idle_stop_hours` consecutive
# hours. A k6 run or active browsing keeps CPU above that, so it only fires
# when the demo is genuinely unused. Set idle_stop_hours = 0 to disable.
resource "aws_cloudwatch_metric_alarm" "idle_stop" {
  count = var.idle_stop_hours > 0 ? 1 : 0

  alarm_name          = "${var.project_name}-idle-stop"
  alarm_description   = "Stop the demo instance after ${var.idle_stop_hours}h of <2% CPU (cost guard)."
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  dimensions          = { InstanceId = aws_instance.demo.id }
  statistic           = "Average"
  period              = 3600
  evaluation_periods  = var.idle_stop_hours
  threshold           = 2
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = ["arn:aws:automate:${var.region}:ec2:stop"]
}
