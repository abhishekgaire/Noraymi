import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig · the staging switch", () => {
  it("a production build started with the staging switch refuses to start", () => {
    expect(() => loadConfig({ WEST4_ENV: "production", ALLOW_STAGING_FEATURES: "true" })).toThrow(
      /refusing to start/,
    );
  });

  it("staging and local may turn the switch on", () => {
    expect(
      loadConfig({ WEST4_ENV: "staging", ALLOW_STAGING_FEATURES: "true" }).allowStagingFeatures,
    ).toBe(true);
    expect(
      loadConfig({ WEST4_ENV: "local", ALLOW_STAGING_FEATURES: "true" }).allowStagingFeatures,
    ).toBe(true);
  });

  it("production without the switch starts, with the switch off", () => {
    const config = loadConfig({ WEST4_ENV: "production" });
    expect(config.env).toBe("production");
    expect(config.allowStagingFeatures).toBe(false);
  });

  it("only 'true' turns the switch on, and the default env is local", () => {
    expect(loadConfig({ ALLOW_STAGING_FEATURES: "1" }).allowStagingFeatures).toBe(false);
    expect(loadConfig({}).env).toBe("local");
    expect(() => loadConfig({ WEST4_ENV: "prod" })).toThrow(/WEST4_ENV must be one of/);
  });
});
