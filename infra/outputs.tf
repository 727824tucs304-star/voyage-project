output "server_id" {
  description = "Instance ID of the application server."
  value       = data.aws_instance.server.id
}

output "server_state" {
  description = "Current state of the server (running or stopped)."
  value       = data.aws_instance.server.instance_state
}

output "server_instance_type" {
  description = "Instance type of the server."
  value       = data.aws_instance.server.instance_type
}

output "elastic_ip" {
  description = "Fixed public address of the server."
  value       = data.aws_eip.server.public_ip
}

output "root_volume_size_gb" {
  description = "Size of the root disk in GB."
  value       = data.aws_ebs_volume.root.size
}

output "backup_bucket_region" {
  description = "Region of the backup bucket."
  value       = data.aws_s3_bucket.backups.region
}

output "server_role_arn" {
  description = "IAM role attached to the server."
  value       = data.aws_iam_role.server.arn
}
