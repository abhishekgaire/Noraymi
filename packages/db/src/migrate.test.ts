import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listMigrations } from "./migrate.js";

async function folderWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "west4-migrations-"));
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, name), sql);
  return dir;
}

describe("listMigrations", () => {
  it("returns files in number order with a checksum", async () => {
    const dir = await folderWith({
      "0002_two.sql": "select 2;",
      "0001_one.sql": "select 1;",
    });
    const list = await listMigrations(dir);
    expect(list.map((m) => m.name)).toEqual(["0001_one.sql", "0002_two.sql"]);
    expect(list[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a badly named file", async () => {
    const dir = await folderWith({ "1-one.sql": "select 1;" });
    await expect(listMigrations(dir)).rejects.toThrow(/file name must look like/);
  });

  it("rejects a gap or a duplicate number", async () => {
    const gap = await folderWith({ "0001_one.sql": "", "0003_three.sql": "" });
    await expect(listMigrations(gap)).rejects.toThrow(/expected migration number 0002/);
    const dup = await folderWith({ "0001_one.sql": "", "0001_uno.sql": "" });
    await expect(listMigrations(dup)).rejects.toThrow(/expected migration number 0002/);
  });
});
