import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkMapping,
  loadDemoSeed,
  marketingConsent,
  optedOut,
  prepareImport,
  resolveVenue,
  runImport,
  withVenue,
  type ImportResult,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW } from "@west4/shared";
import { queueText } from "../texts/queue.js";

/**
 * M9-03 through the texts: a guest who opted out on the old site gets no text
 * from us (not even Booking confirmed), and a marketing opt-in counts only
 * with its proof. The export is made up for the test.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let venueId: string;
let result: ImportResult;

const OPTED_OUT = "+12125557001";
const WITH_PROOF = "+12125557002";
const NO_PROOF = "+12125557003";

const FILES: Record<string, string> = {
  "mapping.json": JSON.stringify({
    mapping_version: 1,
    source: "test-consents",
    files: {
      guests: { file: "guests.csv", columns: { legacy_ref: "id", name: "name", phone: "phone" } },
      consents: {
        file: "consents.csv",
        columns: {
          legacy_ref: "id",
          guest_ref: "guest",
          channel: "channel",
          kind: "kind",
          given_at: "in",
          revoked_at: "out",
          revoked_via: "how",
          source: "form",
          text_version: "words",
          ip: "ip",
        },
        values: { revoked_via: { "Unsubscribed on the site": "guest_page", STOP: "keyword" } },
      },
    },
  }),
  "guests.csv": `id,name,phone\nG1,Opted Out,${OPTED_OUT}\nG2,With Proof,${WITH_PROOF}\nG3,No Proof,${NO_PROOF}\nG4,Abroad,+33 1 45 67 89 00\n`,
  "consents.csv":
    "id,guest,channel,kind,in,out,how,form,words,ip\n" +
    // An opt-out of the old site's promotions: we send this number nothing at all.
    "K1,G1,sms,marketing,2026-05-01 19:00,2026-06-01 10:00,Unsubscribed on the site,Old booking form,v3,198.51.100.4\n" +
    "K2,G2,sms,marketing,2026-05-02 19:00,,,Old booking form,v3,198.51.100.5\n" +
    "K3,G3,sms,marketing,2026-05-03 19:00,,,,v3,\n",
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
  const venue = await resolveVenue(owner, venueId);
  const mapping = checkMapping(JSON.parse(FILES["mapping.json"]!)).mapping!;
  result = await runImport({
    pool: owner,
    venue,
    prepared: prepareImport(mapping, (f) => FILES[f]!, venue.timeZone),
    dryRun: false,
  });
});

afterAll(async () => {
  await app.end();
  await owner.end();
  await db.drop();
});

describe("imported guests and their consents (M9-03)", () => {
  it("counts consents by kind: marketing opt-ins with proof, opt-outs, and opt-ins dropped for lack of proof", () => {
    expect(result.reconciles).toBe(true);
    expect(result.consents).toMatchObject({
      marketing_with_proof: 1,
      opt_outs: 1,
      dropped_no_proof: 1,
      dropped: [{ legacy_ref: "K3", missing: ["the form", "the IP address"] }],
    });
    expect(result.listed).toEqual([
      {
        file: "guests.csv",
        line: 5,
        message: "phone +33145678900 isn't a +1 number: imported without it",
      },
    ]);
  });

  it("a guest who opted out on the old site gets no text from us, not even Booking confirmed", async () => {
    expect(await withVenue(app, { venueId }, (c) => optedOut(c, venueId, OPTED_OUT))).toBe(true);
    await expect(
      withVenue(app, { venueId }, (c) =>
        queueText(
          c,
          venueId,
          {
            templateKey: "booking_confirmed",
            to: OPTED_OUT,
            params: {
              party: 4,
              time: "9:00 PM",
              date: "Fri Oct 2",
              gratuity: "20%",
              deposit: "$40.00",
              cutoff: "Thu Oct 1, 9:00 PM",
              link: "west4karaoke.com/b/x",
            },
            guestId: null,
            context: null,
            sentBy: null,
            now: SEED_NOW,
          },
          { allowList: null },
        ),
      ),
    ).rejects.toMatchObject({ details: { reason: "opted_out" } });
  });

  it("holds no marketing consent without its proof", async () => {
    const consent = (phone: string) =>
      withVenue(app, { venueId }, (c) => marketingConsent(c, venueId, phone));
    expect(await consent(WITH_PROOF)).toBe(true);
    expect(await consent(NO_PROOF)).toBe(false);
    const r = await owner.query(
      `select count(*)::int as n from consents where venue_id = $1 and kind = 'marketing' and revoked_at is null
          and (given_at is null or source is null or text_version is null or ip is null)`,
      [venueId],
    );
    expect(r.rows[0].n).toBe(0);
    const proof = await owner.query(
      "select source, text_version, host(ip) as ip from consents where venue_id = $1 and phone_e164 = $2",
      [venueId, WITH_PROOF],
    );
    expect(proof.rows).toEqual([
      { source: "import:test-consents · Old booking form", text_version: "v3", ip: "198.51.100.5" },
    ]);
  });
});
