import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { insertOrder, loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { sweepPrintJobs } from "./print.js";

/** M3-13: tickets on Star CloudPRNT and Epson Server Direct Print printers, failures and reprints. */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
let who: Principal;
const as = (slug: string, role: string, session: "passkey" | "pin"): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session,
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role: role as never }],
});
const staff = (method: "GET" | "POST", path: string, payload?: object) =>
  app.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
interface Printer {
  device_id: string;
  username: string;
  password: string;
}
const basic = (p: Printer) =>
  `Basic ${Buffer.from(`${p.username}:${p.password}`).toString("base64")}`;

/** A ringing order of Bud Lights on Room 5, accepted by Maya: one ticket job at the bar. */
async function acceptedOrder(): Promise<string> {
  const id = await withVenue(pool, { venueId }, (c) =>
    insertOrder(c, venueId, {
      checkId: ids["chk_room5"]!,
      sessionId: ids["sess_room5"]!,
      source: "room",
      placedAt: clock.now().toString(),
      businessDate: "2026-09-25",
      items: [
        {
          variantId: ids["menu_bud_regular"]!,
          itemId: ids["menu_bud"]!,
          options: [],
          qty: 4,
          unitCents: 800,
          name: "Bud Light",
          alcohol: true,
          taxCategory: "drink",
          station: "bar",
        },
      ],
    }),
  );
  who = as("maya", "bartender", "pin");
  expect((await staff("POST", `/orders/${id}/accept`, {})).statusCode).toBe(200);
  return (await raw.query<{ id: string }>("select id from print_jobs where order_id = $1", [id]))
    .rows[0]!.id;
}

/** A printer of each protocol, polling as it would: its next job's text and id, then its confirmation. */
const PROTOCOLS = {
  cloudprnt: {
    async poll(p: Printer): Promise<{ id: string; text: string } | null> {
      const r = await app.inject({
        method: "POST",
        url: "/v1/print/cloudprnt",
        headers: { authorization: basic(p) },
        payload: {
          status: "23 6 0 0 0 0 0 0 0",
          printerMAC: "00:11:62:aa:bb:cc",
          statusCode: "200 OK",
        },
      });
      expect(r.statusCode).toBe(200);
      if (!r.json().jobReady) return null;
      const token = r.json().jobToken as string;
      const job = await app.inject({
        method: "GET",
        url: `/v1/print/cloudprnt?mac=00:11:62:aa:bb:cc&type=text/plain&token=${token}`,
        headers: { authorization: basic(p) },
      });
      expect(job.headers["content-type"]).toMatch(/text\/plain/);
      return { id: token, text: job.body };
    },
    async confirm(p: Printer, id: string) {
      const r = await app.inject({
        method: "DELETE",
        url: `/v1/print/cloudprnt?mac=00:11:62:aa:bb:cc&code=200%20OK&token=${id}`,
        headers: { authorization: basic(p) },
      });
      expect(r.statusCode).toBe(200);
    },
  },
  server_direct: {
    async poll(p: Printer): Promise<{ id: string; text: string } | null> {
      const r = await app.inject({
        method: "POST",
        url: "/v1/print/epson",
        headers: { authorization: basic(p), "content-type": "application/x-www-form-urlencoded" },
        payload: "ConnectionType=GetRequest&ID=bar&Name=TM-m30III",
      });
      expect(r.statusCode).toBe(200);
      if (!r.body) return null;
      const id = /<printjobid>([^<]+)<\/printjobid>/.exec(r.body)![1]!;
      const text = [...r.body.matchAll(/<text>([^<]*)&#10;<\/text>/g)]
        .map((m) => m[1]!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))))
        .join("\n");
      return { id, text };
    },
    async confirm(p: Printer, id: string) {
      const file = `<?xml version="1.0"?><PrintResponseInfo Version="2.00"><ePOSPrint><Parameter><devid>local_printer</devid><printjobid>${id}</printjobid></Parameter><PrintResponse><response success="true" code="" status="251658262" battery="0" printjobid="${id}"/></PrintResponse></ePOSPrint></PrintResponseInfo>`;
      const r = await app.inject({
        method: "POST",
        url: "/v1/print/epson",
        headers: { authorization: basic(p), "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({
          ConnectionType: "SetResponse",
          ID: "bar",
          ResponseFile: file,
        }).toString(),
      });
      expect(r.statusCode).toBe(200);
    },
  },
} as const;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async (r) => (r.url.startsWith("/v1/venues/") ? who : undefined)],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

const addPrinter = async (protocol: string, name: string): Promise<Printer> => {
  who = as("abhishek", "owner", "passkey");
  const r = await staff("POST", "/printers", { name, station: "bar", protocol });
  expect(r.statusCode).toBe(201);
  return r.json();
};

for (const protocol of ["cloudprnt", "server_direct"] as const) {
  describe(`a ${protocol} printer`, () => {
    const proto = PROTOCOLS[protocol];
    let bar: Printer;

    it("prints o1's ticket when it's accepted, and its confirmation marks the job printed", async () => {
      bar = await addPrinter(protocol, `Bar printer · ${protocol}`);
      // Earlier jobs (another protocol's run) are confirmed first so this printer starts clean.
      await raw.query(
        "update print_jobs set status = 'printed', confirmed_at = now() where status in ('queued', 'sent')",
      );
      const job = await acceptedOrder();
      const got = await proto.poll(bar);
      expect(got?.id).toBe(job);
      expect(got!.text).toContain("ROOM 5");
      expect(got!.text).toContain("4 x Bud Light");
      expect(got!.text).toContain("Accepted by Maya S.");
      expect(got!.text).toMatch(/ID (OK|CHECK) \d+ of 4/);
      await proto.confirm(bar, job);
      const row = await raw.query<{ status: string; confirmed: boolean }>(
        "select status, confirmed_at is not null as confirmed from print_jobs where id = $1",
        [job],
      );
      expect(row.rows[0]).toEqual({ status: "printed", confirmed: true });
      expect(await proto.poll(bar)).toBeNull();
    });

    it("unplugged: after three polls it's failed and listed; reprints say REPRINT 2, then REPRINT 3", async () => {
      const job = await acceptedOrder();
      clock.set(clock.now().add({ seconds: 16 }));
      expect(await sweepPrintJobs(pool, clock.now())).toBeGreaterThanOrEqual(1);
      who = as("maya", "bartender", "pin");
      const failed = (await staff("GET", "/print-jobs?status=failed")).json().jobs as {
        id: string;
        room_name: string;
      }[];
      expect(failed.find((j) => j.id === job)).toMatchObject({ room_name: "Room 5" });
      const events = await raw.query<{ n: number }>(
        "select count(*)::int as n from venue_events where type = 'print_job.failed' and entity_id = $1",
        [job],
      );
      expect(events.rows[0]!.n).toBe(1);

      const first = await staff("POST", `/print-jobs/${job}/reprint`);
      expect(first.json()).toMatchObject({ reprint_n: 2 });
      expect(
        (await staff("GET", "/print-jobs?status=failed"))
          .json()
          .jobs.some((j: { id: string }) => j.id === job),
      ).toBe(false);
      // That one doesn't print either; the next says REPRINT 3.
      clock.set(clock.now().add({ seconds: 16 }));
      await sweepPrintJobs(pool, clock.now());
      const second = await staff("POST", `/print-jobs/${first.json().job_id}/reprint`);
      expect(second.json()).toMatchObject({ reprint_n: 3 });
      // Plugged back in: the printer prints REPRINT 3, never the jobs that failed.
      const got = await proto.poll(bar);
      expect(got?.id).toBe(second.json().job_id);
      expect(got!.text.split("\n")[0]).toBe("REPRINT 3");
      await proto.confirm(bar, got!.id);
    });

    it("a printer fetches only its own jobs", async () => {
      const other = await addPrinter(protocol, `Other printer · ${protocol}`);
      await raw.query("update devices set station = 'front_desk' where id = $1", [other.device_id]);
      await acceptedOrder();
      const mine = await proto.poll(bar);
      expect(mine).not.toBeNull();
      expect(await proto.poll(other)).toBeNull();
      if (protocol === "cloudprnt") {
        const peek = await app.inject({
          method: "GET",
          url: `/v1/print/cloudprnt?token=${mine!.id}`,
          headers: { authorization: basic(other) },
        });
        expect(peek.statusCode).toBe(404);
      }
      // A wrong secret is no printer at all.
      const wrong = await app.inject({
        method: "POST",
        url: protocol === "cloudprnt" ? "/v1/print/cloudprnt" : "/v1/print/epson",
        headers: { authorization: basic({ ...bar, password: "not-the-secret" }) },
        payload: {},
      });
      expect([401, 403]).toContain(wrong.statusCode);
      await proto.confirm(bar, mine!.id);
    });
  });
}

describe("Admin's test ticket", () => {
  it("prints on the printer it was made for", async () => {
    const p = await addPrinter("cloudprnt", "Front printer");
    await raw.query("update devices set station = 'front_desk' where id = $1", [p.device_id]);
    const r = await staff("POST", `/printers/${p.device_id}/test`);
    expect(r.statusCode).toBe(201);
    const got = await PROTOCOLS.cloudprnt.poll(p);
    expect(got?.text).toContain("TEST TICKET");
    expect(got?.text).toContain("Front printer");
  });
});
