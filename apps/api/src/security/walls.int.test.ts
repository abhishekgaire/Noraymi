import { randomUUID } from "node:crypto";
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
        bucketIdKeys: "id-keys",
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
      // The synthetic check (M8-18), configured for venue B: a job queued as venue A runs nothing.
      synthetic: {
        pool: world.owner,
        config: {
          api_url: "http://127.0.0.1:1",
          venue_id: world.cast.venueB,
          venue_slug: "b",
          device_id: randomUUID(),
          device_key: {},
          membership_id: randomUUID(),
          pin: "1234",
          room_id: randomUUID(),
          reader_id: randomUUID(),
          variant_id: randomUUID(),
        },
      },
    });
    const { rows, findings } = await runJobWalls(world.owner, handlers, world.clock, world.cast, {
      push,
    });
    expect(findings, findings.map((f) => `${f.where}: ${f.why}`).join("\n")).toEqual([]);
    expect(rows.length).toBe(18); // M8-09 added the license reminders, M8-12 the retention job, M8-13 the erase job, M8-18 the synthetic check, M9-15 the money audit, M9-17 the gate's weekly summary, M5-10 the Booking confirmed text, M5-15 the Google hours push
    expect(venueClient.sent).toEqual([]);
  });
});
