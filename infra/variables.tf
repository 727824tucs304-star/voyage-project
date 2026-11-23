variable "region" {
  description = "AWS region where Vespera runs."
  type        = string
  default     = "ap-south-1"
}

variable "instance_id" {
  description = "ID of the Vespera application server."
  type        = string
  default     = "i-0fe75a403fc3723cc"
}

variable "root_volume_id" {
  description = "ID of the server's root disk, which holds the database and recordings."
  type        = string
  default     = "vol-07724caa85f7616f0"
}

variable "backup_bucket" {
  description = "Private S3 bucket that holds off-server backups."
  type        = string
  default     = "vespera-backups-mumbai-493168377375"
}

variable "instance_role_name" {
  description = "IAM role attached to the server."
  type        = string
  default     = "voyage-cost-reader"
}
