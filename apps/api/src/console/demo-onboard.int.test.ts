import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { generateSigningKey, publishRulePack, removeLocalDemoVenue, withVenue } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { builtInRulePacks } from "@west4/shared";
import {
  ONBOARD_EMAIL_DOMAIN,
  ONBOARD_OWNER,
  ONBOARD_SLUG,
  ONBOARD_VENUE_NAME,
  onboardDemoVenue,
} from "./demo-onboard.js";
import { createVenueWithOwner } from "./new-venue.js";

/**
 * The local demo's `--onboard`: Sing Sing made as the Console's New venue
 * makes one (its own organization, the venue, the invited owner, the reason
 * and the emailed invite) and nothing else; a second run replaces the first
 * (its organization and people too); and a `--sing-sing` venue under another
 * venue's organization goes without taking that organization with it.
 */
let db: TestDatabase;
let v: TwoVenues;
let owner: pg.Client;
let rw: pg.Pool;
const STAFF_APP = "http://localhost:5173";

const count = async (sql: string, params: unknown[] = []) =>
  Number((await owner.query<{ n: string }>(sql, params)).rows[0]!.n);

async function emptiness(venueId: string) {
  const n: Record<string, number> = {};
  for (const t of [
    "rooms",
    "menu_items",
    "venue_settings",
    "devices",
    "cash_drawers",
    "licenses",
    "venue_hours",
  ]) {
    const exists = await count("select count(*) as n from pg_class where relname = $1", [t]);
    if (exists)
      n[t] = await count(`select count(*) as n from "${t}" where venue_id = $1`, [venueId]);
  }
  return n;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  rw = appPool(db.url);
  await owner.query(
    "insert into console_staff (name, email) values ('Noraymi support', 'support@demo.west4.local')",
  );
  await publishRulePack(owner, {
    pack: builtInRulePacks[0]!,
    effectiveOn: "2026-09-01",
    approvedBy: ["Abhishek Gaire", "Claude Code"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
});

afterAll(async () => {
  await rw?.end();
  await owner?.end();
  await db?.drop();
});

describe("demo --onboard (Sing Sing through Set up your venue)", () => {
  it("makes an empty venue under a new organization, an invited owner and the emailed invite", async () => {
    const made = await onboardDemoVenue({ owner, app: rw, staffAppUrl: STAFF_APP });
    const venue = (
      await owner.query<{ name: string; slug: string; org_id: string; done: boolean }>(
        "select name, slug, org_id, setup_completed_at is not null as done from venues where id = $1",
        [made.venueId],
      )
    ).rows[0]!;
    expect(venue).toMatchObject({ name: ONBOARD_VENUE_NAME, slug: ONBOARD_SLUG, done: false });
    expect(venue.org_id).toBe(made.orgId);
    expect(made.orgId).not.toBe(v.orgId);
    const people = await owner.query<{ role: string; status: string; email: string }>(
      `select m.role, m.status, u.email from memberships m join users u on u.id = m.user_id
        where m.venue_id = $1`,
      [made.venueId],
    );
    expect(people.rows).toEqual([{ role: "owner", status: "invited", email: ONBOARD_OWNER.email }]);
    expect(
      await count("select count(*) as n from venue_onboarding where venue_id = $1", [made.venueId]),
    ).toBe(1);
    expect(made.inviteUrl).toMatch(new RegExp(`^${STAFF_APP}/invite/[A-Za-z0-9_-]{40,}$`));
    const mail = await owner.query<{ payload: { template: string; data: { inviteUrl: string } } }>(
      "select payload from jobs where kind = 'email.send' and payload->>'to' = $1",
      [ONBOARD_OWNER.email],
    );
    expect(mail.rows).toHaveLength(1);
    expect(mail.rows[0]!.payload.template).toBe("owner_invite");
    expect(mail.rows[0]!.payload.data.inviteUrl).toBe(made.inviteUrl);
    for (const [table, n] of Object.entries(await emptiness(made.venueId)))
      expect(n, table).toBe(0);
  });

  it("a second run replaces the first: one Sing Sing, one owner, the old organization gone", async () => {
    const first = (
      await owner.query<{ id: string; org_id: string }>(
        "select id, org_id from venues where slug = $1",
        [ONBOARD_SLUG],
      )
    ).rows[0]!;
    const made = await onboardDemoVenue({ owner, app: rw, staffAppUrl: STAFF_APP });
    expect(made.venueId).not.toBe(first.id);
    expect(await count("select count(*) as n from venues where slug = $1", [ONBOARD_SLUG])).toBe(1);
    expect(
      await count("select count(*) as n from organizations where id = $1", [first.org_id]),
    ).toBe(0);
    expect(
      await count("select count(*) as n from users where email like $1", [
        `%@${ONBOARD_EMAIL_DOMAIN}`,
      ]),
    ).toBe(1);
    // The other venues are untouched.
    expect(
      await count("select count(*) as n from venues where id = any($1::uuid[])", [
        [v.venueA, v.venueB],
      ]),
    ).toBe(2);
  });

  it("replaces a --sing-sing venue that shares another venue's organization, keeping that organization", async () => {
    await removeLocalDemoVenue(owner, { slug: ONBOARD_SLUG, emailDomain: ONBOARD_EMAIL_DOMAIN });
    const staffId = (await owner.query<{ id: string }>("select id from console_staff limit 1"))
      .rows[0]!.id;
    await createVenueWithOwner((ctx, work) => withVenue(rw, ctx, work), {
      staffId,
      name: "Sing Sing (shortcut)",
      slug: ONBOARD_SLUG,
      orgId: v.orgId,
      legalName: null,
      ownerName: "Andy C.",
      ownerEmail: `andy@${ONBOARD_EMAIL_DOMAIN}`,
      reason: "the --sing-sing shortcut's venue",
    });
    const made = await onboardDemoVenue({ owner, app: rw, staffAppUrl: STAFF_APP });
    expect(made.orgId).not.toBe(v.orgId);
    expect(await count("select count(*) as n from organizations where id = $1", [v.orgId])).toBe(1);
    expect(
      await count("select count(*) as n from users where email = $1", [
        `andy@${ONBOARD_EMAIL_DOMAIN}`,
      ]),
    ).toBe(0);
  });
});
