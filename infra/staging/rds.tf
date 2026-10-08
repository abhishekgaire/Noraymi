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

  backup_retention_period    = var.backup_retention_days
  backup_window              = "08:00-09:00" # 4–5 AM New York, after the 6 AM cutover's quiet hours start
  maintenance_window         = "wed:09:00-wed:10:00"
  auto_minor_version_upgrade = true
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.name}-final"
  copy_tags_to_snapshot      = true
  apply_immediately          = true
}

# Backups and restore (M8-20; spec 13): continuous point-in-time backups for 35 days, copied
# continuously to the second region, so a lost region costs at most 15 minutes of data. A
# per-venue restore starts from a scratch copy restored from these (docs/runbooks/restore-drill.md);
# a lost region from the copy in the second region (docs/runbooks/region-failover.md).
# Only the database is backed up this way: the ID-scan key bucket (s3.tf, id_keys) is never
# versioned, replicated or backed up, so destroying a night's key destroys every copy.
resource "aws_kms_key" "dr" {
  provider                = aws.dr
  description             = "${var.name} data in the second region: the copied database backups"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "dr" {
  provider      = aws.dr
  name          = "alias/${var.name}-data-dr"
  target_key_id = aws_kms_key.dr.key_id
}

resource "aws_db_instance_automated_backups_replication" "dr" {
  provider               = aws.dr
  source_db_instance_arn = aws_db_instance.main.arn
  kms_key_id             = aws_kms_key.dr.arn
  retention_period       = var.backup_retention_days
}

# Reports read here (M8-21; spec 13 · Capacity): a read replica of the main database, so the
# 8-week trends during a Friday peak never take the primary's time from orders and the alarm.
# The API's reports pool connects to it as app_rw (DB_REPLICA_HOST in ecs.tf); without it,
# reports read the primary.
resource "aws_db_instance" "replica" {
  count                      = var.db_reports_replica ? 1 : 0
  identifier                 = "${var.name}-reports"
  replicate_source_db        = aws_db_instance.main.identifier
  instance_class             = var.db_instance_class
  storage_encrypted          = true
  kms_key_id                 = aws_kms_key.data.arn
  vpc_security_group_ids     = [aws_security_group.db.id]
  parameter_group_name       = aws_db_parameter_group.main.name
  publicly_accessible        = false
  multi_az                   = false
  backup_retention_period    = 0
  auto_minor_version_upgrade = true
  skip_final_snapshot        = true
  apply_immediately          = true
}
