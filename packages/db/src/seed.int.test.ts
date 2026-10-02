import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED_NOW } from "@west4/shared";
import { listDevices } from "./devices.js";
import { venueModules } from "./modules.js";
import { loadDemoSeed, readSeedFile, seedFilePath, seedId, type SeedLoadResult } from "./seed.js";
import { createTestDatabase, type TestDatabase } from "./test-helpers.js";

let db: TestDatabase;
let owner: pg.Client;
let first: SeedLoadResult;
let second: SeedLoadResult;
const seed = readSeedFile(seedFilePath({}));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  first = await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } });
  second = await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } });
});

afterAll(async () => {
  await owner.end();
  await db.drop();
});

describe("the M1 part of the demo seed", () => {
  it("loads West 4 with its four memberships", async () => {
    const r = await owner.query<{ name: string; role: string; pin_digits: number }>(
      `select u.name, m.role, m.pin_digits from memberships m join users u on u.id = m.user_id
        where m.venue_id = $1 and m.status = 'active' order by u.name`,
      [first.venueId],
    );
    expect(r.rows).toEqual([
      { name: "Abhishek G.", role: "owner", pin_digits: 6 },
      { name: "Andy C.", role: "manager", pin_digits: 6 },
      { name: "Diego R.", role: "front_desk", pin_digits: 4 },
      { name: "Maya S.", role: "bartender", pin_digits: 4 },
    ]);
    const venue = await owner.query<{ name: string; slug: string; rule_pack_id: string }>(
      "select name, slug, rule_pack_id from venues where id = $1",
      [first.venueId],
    );
    expect(venue.rows[0]).toEqual({
      name: "West 4 Boho Karaoke",
      slug: "west4karaoke",
      rule_pack_id: "us-ny-new-york-county",
    });
  });

  it("loads 28 devices, 13 of 14 room tablets online, phones owned by their people", async () => {
    const devices = await listDevices(owner, first.venueId);
    expect(devices).toHaveLength(28);
    const tablets = devices.filter((d) => d.kind === "room_tablet");
    expect(tablets).toHaveLength(14);
    expect(tablets.filter((d) => d.online)).toHaveLength(13);
    expect(tablets.find((d) => !d.online)?.name).toBe("Tablet · Room 4");
    const maya = await seedId(owner, first.venueId, "maya");
    expect(devices.find((d) => d.name === "Maya's phone")?.user_id).toBe(maya);
  });

  it("stores the settings in spec 03's shapes, with the seed's nulls kept empty", async () => {
    const r = await owner.query<{ key: string; value: Record<string, unknown> }>(
      "select key, value from venue_settings where venue_id = $1 and version = 1",
      [first.venueId],
    );
    const by = Object.fromEntries(r.rows.map((row) => [row.key, row.value]));
    expect(Object.keys(by)).toHaveLength(16);
    expect((by["prices"]!["billing"] as { incrementMin: number }).incrementMin).toBe(1);
    expect(by["prices"]!["minSpend"]).toEqual([]);
    expect(by["tabs"]!["flagOverCents"]).toBe(60000);
    expect(by["rooms"]).toMatchObject({ cleaningEnds: "staff", cleaningFlagMin: 8 });
    expect(by["barMode"]).toMatchObject({ songsPerRound: 1, songPriceCents: null });
    expect(by["safety"]).toMatchObject({ occupancyLimit: null });
    expect((by["pay"]!["gratuity"] as { pct: number }).pct).toBe(20);
  });

  it("turns on 13 modules and refuses the phase 2 ones", async () => {
    const rows = await venueModules(owner, first.venueId);
    expect(rows.filter((r) => r.state === "on").map((r) => r.module_id)).toHaveLength(17); // 13 + 4 core
    expect(rows.find((r) => r.module_id === "kitchen")).toMatchObject({
      allowed: false,
      state: "off",
    });
    expect(rows.find((r) => r.module_id === "online_booking")).toMatchObject({
      allowed: true,
      state: "on",
    });
  });

  it("writes no permission rows, because West 4's table is the default one", async () => {
    const r = await owner.query(
      "select count(*)::int as n from role_permissions where venue_id = $1",
      [first.venueId],
    );
    expect(r.rows[0]).toEqual({ n: 0 });
    expect(first.counts.permissionOverrides).toBe(0);
  });

  it("sets the simulated clock to Fri Sep 25, 2026, 10:41 PM", async () => {
    const r = await owner.query<{ simulated_at: Date; set_by: string }>(
      "select simulated_at, set_by from clock_control",
    );
    expect(r.rows[0]?.simulated_at.getTime()).toBe(SEED_NOW.epochMilliseconds);
    expect(r.rows[0]?.set_by).toBe("seed");
  });

  it("gives the same ids on a second load, and keeps every slug in seed_ids", async () => {
    expect(second.ids).toEqual(first.ids);
    expect(second.venueId).toBe(first.venueId);
    const r = await owner.query<{ n: number }>(
      "select count(*)::int as n from seed_ids where venue_id = $1",
      [first.venueId],
    );
    expect(r.rows[0]?.n).toBe(Object.keys(first.ids).length);
    expect(await seedId(owner, first.venueId, "dev_router")).toBe(first.ids["dev_router"]);
    const devices = await owner.query(
      "select count(*)::int as n from devices where venue_id = $1",
      [first.venueId],
    );
    expect(devices.rows[0]).toEqual({ n: seed.devices.length });
  });

  it("refuses to run against production", async () => {
    await expect(
      loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "production" } }),
    ).rejects.toThrow(/never loads into production/);
  });
});

describe("the M3 part of the demo seed", () => {
  const drinks = async (slug: string) =>
    (
      await owner.query<{ cents: number }>(
        `select coalesce(sum(amount_cents), 0)::int as cents from check_lines
          where venue_id = $1 and check_id = $2 and tax_category = 'drink'`,
        [first.venueId, await seedId(owner, first.venueId, slug)],
      )
    ).rows[0]!.cents;

  it("keeps the ringing 2 × Margarita · Peach off Room 9's tab: drinks read $158.00", async () => {
    expect(await drinks("chk_room9")).toBe(15800);
    const o1 = await owner.query<{ status: string; lines: number }>(
      `select o.status, (select count(*)::int from check_lines l join order_items i on i.id = l.source_id
          where i.order_id = o.id) as lines from orders o where o.id = $1`,
      [await seedId(owner, first.venueId, "order_o1")],
    );
    expect(o1.rows[0]).toEqual({ status: "ringing", lines: 0 });
  });

  it("loads Diego's unsent Red Bull on Tariq A.'s tab, outside the check", async () => {
    const r = await owner.query<{ lines: { variant_id: string; qty: number }[] }>(
      "select lines from order_drafts where venue_id = $1 and membership_id = $2 and check_id = $3",
      [
        first.venueId,
        await seedId(owner, first.venueId, "diego.membership"),
        await seedId(owner, first.venueId, "chk_t5"),
      ],
    );
    expect(r.rows[0]?.lines).toEqual([
      {
        variant_id: await seedId(owner, first.venueId, "menu_redbull_regular"),
        qty: 1,
        option_ids: [],
      },
    ]);
    expect(await drinks("chk_t5")).toBe(7900);
  });

  it("loads Diego's $70.00 void of the Large bucket, pending and routed to Andy", async () => {
    const r = await owner.query<{
      kind: string;
      amount_cents: string;
      reason: string;
      status: string;
      requested_by: string;
      routed_to: string;
      line: string;
    }>(
      `select a.kind, a.amount_cents, a.reason, a.status, a.requested_by, a.routed_to, l.description as line
         from approvals a join check_lines l on l.id = (a.payload->>'line_id')::bigint
        where a.venue_id = $1 and a.target_id = $2`,
      [first.venueId, await seedId(owner, first.venueId, "chk_t5")],
    );
    expect(r.rows).toEqual([
      {
        kind: "void",
        amount_cents: "7000",
        reason: "rang it wrong",
        status: "pending",
        requested_by: await seedId(owner, first.venueId, "diego"),
        routed_to: await seedId(owner, first.venueId, "andy"),
        line: "Large bucket · 10 beers",
      },
    ]);
  });

  it("adds up reason-only use from the lines: Maya $12.00, Diego $0.00", async () => {
    for (const r of seed.reason_only_used_tonight) {
      const used = await owner.query<{ cents: number }>(
        `select coalesce(sum(abs(amount_cents)), 0)::int as cents from check_lines
          where venue_id = $1 and added_by = $2 and kind in ('comp', 'void') and approved_by is null`,
        [first.venueId, await seedId(owner, first.venueId, r.person)],
      );
      expect(used.rows[0]?.cents).toBe(r.cents);
    }
  });
});
