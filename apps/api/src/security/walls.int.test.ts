import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { buildApp } from "../app.js";
import { FakeMailer } from "../email/mailer.js";
import { makeHandlers } from "../jobs/registry.js";
import { FakePushSender } from "../push/sender.js";
import { FakeTextSender } from "../texts/sender.js";
import { FakeVenueClient } from "../texts/venue.js";
import { suiteWorld, type SuiteWorld } from "./setup.js";
import { checkWebhooks, runJobWalls, runRouteWalls } from "./wall-suite.js";

/**
 * The venue-wall suite (M1-37): every endpoint as venue A with venue B's ids,
 * every job kind run for venue A with venue B's ids, every webhook with its
 * own venue. CI's "walls" job; `pnpm test:walls` locally.
 */
let world: SuiteWorld;

beforeAll(async () => {
  world = await suiteWorld();
});

afterAll(async () => {
  await world.close();
});

describe("the venue wall", () => {
  it("every endpoint called as venue A with venue B's ids answers not found", async () => {
    const app = buildApp(world.appOptions);
    await app.ready();
    try {
      const { rows, findings } = await runRouteWalls(app, world.cast, world.fixtures);
      expect(findings, findings.map((f) => `${f.where}: ${f.why}`).join("\n")).toEqual([]);
      expect(rows.filter((r) => r.outcome === "walled").length).toBeGreaterThan(20);
      expect(checkWebhooks(app.routes)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("every job kind run for venue A with venue B's ids finds nothing", async () => {
    const push = new FakePushSender();
    const venueClient = new FakeVenueClient();
    const handlers = makeHandlers({
      s3: {
        client: new S3Client({
          region: "us-east-1",
          endpoint: "http://127.0.0.1:1",
          credentials: { accessKeyId: "x", secretAccessKey: "y" },
        }),
        bucketFiles: "files",
        bucketAudit: "audit",
      },
      mailer: new FakeMailer(),
      email: {
        env: "local",
        smtpUrl: "smtp://localhost:1025",
        from: "west4@test",
        allowList: null,
      },
      push,
      texts: new FakeTextSender(),
      venueTexts: {
        client: venueClient,
        settings: { publicApiUrl: null },
        secretKey: Buffer.alloc(32, 7),
      },
    });
    const { rows, findings } = await runJobWalls(world.owner, handlers, world.clock, world.cast, {
      push,
    });
    expect(findings, findings.map((f) => `${f.where}: ${f.why}`).join("\n")).toEqual([]);
    expect(rows.length).toBe(10);
    expect(venueClient.sent).toEqual([]);
  });
});
