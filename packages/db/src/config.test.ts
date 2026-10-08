import { describe, expect, it } from "vitest";
import {
  appDatabaseUrl,
  reportsDatabaseUrl,
  databaseName,
  databaseUrl,
  defaultDatabaseUrl,
  withDatabase,
} from "./config.js";

describe("databaseUrl", () => {
  it("prefers DATABASE_URL", () => {
    expect(databaseUrl({ DATABASE_URL: "postgres://a:b@h/x", DB_HOST: "ignored" })).toBe(
      "postgres://a:b@h/x",
    );
  });

  it("builds a URL from the parts ECS injects, with the password escaped and TLS required", () => {
    expect(
      databaseUrl({
        DB_HOST: "db.example.internal",
        DB_USER: "west4",
        DB_PASSWORD: "p@ss/w:rd",
        DB_NAME: "west4",
      }),
    ).toBe("postgres://west4:p%40ss%2Fw%3Ard@db.example.internal:5432/west4?sslmode=require");
  });

  it("falls back to the local Compose database", () => {
    expect(databaseUrl({})).toBe(defaultDatabaseUrl);
  });

  it("swaps the database name", () => {
    expect(withDatabase("postgres://u:p@h:5432/west4?sslmode=require", "postgres")).toBe(
      "postgres://u:p@h:5432/postgres?sslmode=require",
    );
    expect(databaseName("postgres://u:p@h:5432/west4")).toBe("west4");
  });
});

describe("appDatabaseUrl", () => {
  it("uses APP_DATABASE_URL, else app_rw on the same host as the owner, else the local app_rw", () => {
    expect(appDatabaseUrl({ APP_DATABASE_URL: "postgres://app_rw:x@h/west4" })).toBe(
      "postgres://app_rw:x@h/west4",
    );
    expect(
      appDatabaseUrl({ DB_HOST: "h", DB_PASSWORD: "owner-pw", APP_DB_PASSWORD: "app-pw" }),
    ).toBe("postgres://app_rw:app-pw@h:5432/west4?sslmode=require");
    expect(appDatabaseUrl({})).toBe("postgres://app_rw:app_rw@localhost:5432/west4");
  });
});

describe("reportsDatabaseUrl (M8-21)", () => {
  it("is the replica as app_rw, REPORTS_DATABASE_URL first, else none (reports read the primary)", () => {
    expect(reportsDatabaseUrl({ REPORTS_DATABASE_URL: "postgres://app_rw:x@r/west4" })).toBe(
      "postgres://app_rw:x@r/west4",
    );
    expect(
      reportsDatabaseUrl({ DB_HOST: "h", DB_REPLICA_HOST: "r", APP_DB_PASSWORD: "app-pw" }),
    ).toBe("postgres://app_rw:app-pw@r:5432/west4?sslmode=require");
    expect(reportsDatabaseUrl({ DB_HOST: "h" })).toBeNull();
    expect(reportsDatabaseUrl({})).toBeNull();
  });
});
