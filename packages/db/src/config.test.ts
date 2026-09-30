import { describe, expect, it } from "vitest";
import { databaseName, databaseUrl, defaultDatabaseUrl, withDatabase } from "./config.js";

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
