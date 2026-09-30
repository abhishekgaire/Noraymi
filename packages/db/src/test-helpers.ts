import { randomBytes } from "node:crypto";
import { createDatabase, dropDatabase } from "./admin.js";
import { databaseUrl, withDatabase } from "./config.js";

export interface TestDatabase {
  readonly url: string;
  drop(): Promise<void>;
}

/**
 * A throwaway database on the local server, named west4_test_xxxx, so tests
 * never touch the development database and can run side by side.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `west4_test_${randomBytes(4).toString("hex")}`;
  const url = withDatabase(databaseUrl(), name);
  await createDatabase(url);
  return {
    url,
    drop: () => dropDatabase(url),
  };
}
