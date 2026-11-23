# Read-only description of the existing Vespera environment.
# These are data sources: Terraform looks the resources up and changes nothing in AWS.
# Managing them as Terraform-owned resources is a later phase, after review and approval.

data "aws_instance" "server" {
  instance_id = var.instance_id
}

data "aws_eip" "server" {
  public_ip = data.aws_instance.server.public_ip
}

data "aws_ebs_volume" "root" {
  filter {
    name   = "volume-id"
    values = [var.root_volume_id]
  }
}

data "aws_s3_bucket" "backups" {
  bucket = var.backup_bucket
}

data "aws_iam_role" "server" {
  name = var.instance_role_name
}
