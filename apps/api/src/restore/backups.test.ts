import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The backup plan as Terraform writes it (M8-20; spec 13 · Backups and
 * restore, spec 12 · How long we keep things): 35 days of point-in-time
 * restore, copied continuously to a second region, and the ID-scan key
 * bucket (M8-14) never versioned, replicated or backed up.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DIR = join(ROOT, "infra/staging");
const tf = readdirSync(DIR)
  .filter((f) => f.endsWith(".tf"))
  .map((f) => readFileSync(join(DIR, f), "utf8"))
  .join("\n");
const block = (kind: string, name: string): string => {
  const start = tf.indexOf(`resource "${kind}" "${name}" {`);
  if (start < 0) return "";
  const end = tf.indexOf("\n}\n", start);
  return tf.slice(start, end);
};

describe("the backup plan (M8-20)", () => {
  it("keeps 35 days of point-in-time restore and copies it to the second region", () => {
    expect(tf).toMatch(/variable "backup_retention_days" \{[^}]*default\s+= 35/);
    expect(block("aws_db_instance", "main")).toContain(
      "backup_retention_period    = var.backup_retention_days",
    );
    const copy = block("aws_db_instance_automated_backups_replication", "dr");
    expect(copy).toContain("provider               = aws.dr");
    expect(copy).toContain("retention_period       = var.backup_retention_days");
    expect(tf).toMatch(/provider "aws" \{\s*alias\s+= "dr"\s*region = var\.dr_region/);
  });

  it("never versions, replicates or backs up the ID-scan key bucket", () => {
    expect(tf).toMatch(/all_buckets\s+= \{[^}]*\}/);
    const all = /all_buckets\s+= \{([^}]*)\}/.exec(tf)![1]!;
    expect(all).not.toContain("id_keys");
    for (const kind of [
      "aws_s3_bucket_versioning",
      "aws_s3_bucket_replication_configuration",
      "aws_backup_selection",
    ])
      for (const m of tf.matchAll(
        new RegExp(`resource "${kind}" "[^"]+" \\{[\\s\\S]*?\\n\\}`, "g"),
      ))
        expect(m[0], kind).not.toContain("id_keys");
  });
});
