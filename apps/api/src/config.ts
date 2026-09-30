import { databaseUrl } from "@west4/db";

export type West4Env = "local" | "staging" | "production";

export interface Config {
  readonly env: West4Env;
  /**
   * The staging-only switch (M1-02). When on, the simulated clock (M1-06) and
   * the demo PINs (M1-23) are allowed. A production build refuses to start
   * with it on.
   */
  readonly allowStagingFeatures: boolean;
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
}

const ENVS: readonly West4Env[] = ["local", "staging", "production"];

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const rawEnv = source["WEST4_ENV"] ?? "local";
  if (!ENVS.includes(rawEnv as West4Env)) {
    throw new Error(`WEST4_ENV must be one of ${ENVS.join(", ")}, got ${JSON.stringify(rawEnv)}`);
  }
  const env = rawEnv as West4Env;
  const allowStagingFeatures = source["ALLOW_STAGING_FEATURES"] === "true";
  if (allowStagingFeatures && env === "production") {
    throw new Error(
      "ALLOW_STAGING_FEATURES is on but WEST4_ENV is production: refusing to start. " +
        "The simulated clock and the demo PINs never run against real money.",
    );
  }
  return {
    env,
    allowStagingFeatures,
    port: Number(source["PORT"] ?? 3000),
    host: source["HOST"] ?? "127.0.0.1",
    databaseUrl: databaseUrl(source),
  };
}
