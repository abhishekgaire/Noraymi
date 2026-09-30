variable "region" {
  type    = string
  default = "us-east-1"
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
