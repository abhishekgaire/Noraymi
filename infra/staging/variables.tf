variable "region" {
  type    = string
  default = "us-east-1"
}

variable "dr_region" {
  description = "The second region: backups copied continuously, the warm standby (M8-20)."
  type        = string
  default     = "us-west-2"
}

variable "backup_retention_days" {
  description = "Point-in-time restore window, in both regions (spec 12: 35 days)."
  type        = number
  default     = 35
}

variable "environment" {
  type    = string
  default = "staging"
}

variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "west4-staging"
}

variable "github_repository" {
  description = "owner/repo allowed to deploy through the GitHub OIDC role."
  type        = string
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_reports_replica" {
  description = "The read replica reports run on (M8-21; spec 13 · Capacity)."
  type        = bool
  default     = true
}

variable "db_multi_az" {
  description = "Off on staging to save money; production keeps the standby the spec asks for."
  type        = bool
  default     = false
}

variable "postgres_version" {
  type    = string
  default = "16.15"
}

variable "task_cpu" {
  type    = number
  default = 256
}

variable "task_memory" {
  type    = number
  default = 512
}

variable "email_from" {
  type        = string
  description = "The From header on every email (M1-18)"
  default     = "West 4 staging <no-reply@example.com>"
}

variable "email_allow_list" {
  type        = string
  description = "Staging sends only to these comma-separated addresses and @domains (M1-18); empty sends nothing"
  default     = ""
}
