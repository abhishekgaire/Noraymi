# Managed Postgres 16 (spec 01). RDS manages the master password in Secrets
# Manager; ECS injects it into the tasks, so Terraform never sees it.
resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = var.name
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

resource "aws_db_instance" "main" {
  identifier        = var.name
  engine            = "postgres"
  engine_version    = var.postgres_version
  instance_class    = var.db_instance_class
  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true
  kms_key_id        = aws_kms_key.data.arn

  db_name                       = "west4"
  username                      = "west4"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.data.arn

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  backup_retention_period    = 7
  backup_window              = "08:00-09:00" # 4–5 AM New York, after the 6 AM cutover's quiet hours start
  maintenance_window         = "wed:09:00-wed:10:00"
  auto_minor_version_upgrade = true
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.name}-final"
  copy_tags_to_snapshot      = true
  apply_immediately          = true
}
