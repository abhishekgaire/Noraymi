// Local only: Sing Sing Karaoke Astoria as a second demo venue, with Kitchen & food on.
// Run by `scripts/demo-local.sh --sing-sing` (and `scripts/demo-start.sh --sing-sing`) right after
// West 4's seed, because it copies West 4's settings as its starting point. It:
//   1. removes the last Sing Sing demo venue, if any (its rows and its four demo people);
//   2. makes the venue (slug `singsing`, under West 4's organization, so the fake Stripe account is
//      shared), with West 4's settings except Sing Sing's own choices (docs/venues/sing-sing/venue.md):
//      its hours, deposits off for online bookings, "Keep the card behind the bar" at a walk-in
//      check-in (D116), all ages until 8 PM (D108), its own allergy notice (D125), approvals by a
//      manager's PIN at the register (D126), and its Choose your features (D124): FEATURES_ON on,
//      FEATURES_OFF off, the rest as West 4's;
//   3. 6 rooms (Room 1 to Room 6, with West 4's Rooms 1 to 6's sizes: placeholders until the manager
//      gives the real ones), the two drawers and a pretend kitchen network printer (with the allergy
//      notice, the kitchen's two prerequisites are met);
//   4. Abhishek (owner) and Andy (manager) to sign in by invite, Maya (bartender, PIN 4071) and
//      Diego (front desk, PIN 6358), all with @singsing.demo.local emails;
//   5. Sing Sing's menu from docs/venues/sing-sing/import through the importer (M9-06);
//   6. prints the owner's and the manager's invite links.
// Refuses production and anything that isn't a local database. Never needs the API to be running.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = await import(pathToFileURL(path.join(root, "packages/db/dist/index.js")).href);
const { parseSetting, siteContentSchema } = await import("@west4/shared");

const url = process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4";
const staffUrl = process.env["STAFF_APP_URL"] ?? "http://localhost:5173";
if ((process.env["WEST4_ENV"] ?? "local") !== "local")
  throw new Error("demo-sing-sing: local only (WEST4_ENV isn't local)");
if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(url).hostname))
  throw new Error(`demo-sing-sing: not a local database (${url})`);

const SLUG = "singsing";
const TEMPLATE = "west4karaoke";
const EMAIL_DOMAIN = "singsing.demo.local";
// Sing Sing's own allergy notice (D125; docs/venues/sing-sing/venue.md): the venue's English, and our
// Spanish for the venue to confirm.
const ALLERGY_EN = "Allergen information for menu items is available. Ask an employee for details.";
const ALLERGY_ES =
  "La información sobre alérgenos de los platos del menú está disponible. Pregunte a un empleado para más detalles.";
// Sing Sing's Choose your features (D124, D126; venue.md): on, off, and the rest at the plan's default.
const FEATURES_ON = [
  "rooms",
  "bar_screen",
  "kitchen",
  "website",
  "online_booking",
  "room_ordering",
  "card_behind_bar",
  "cash_discount",
  // Its own card machine beside Stripe's readers (D126): both on, so it can move to readers later.
  "outside_card",
];
const FEATURES_OFF = ["deposits", "bar_mode", "song_system", "marketing_texts", "room_tablets"];
const PEOPLE = [
  { key: "abhishek", name: "Abhishek G.", role: "owner", digits: 6, pin: null },
  { key: "andy", name: "Andy C.", role: "manager", digits: 6, pin: null },
  { key: "maya", name: "Maya S.", role: "bartender", digits: 4, pin: "4071" },
  { key: "diego", name: "Diego R.", role: "front_desk", digits: 4, pin: "6358" },
];
const emailOf = (key) => `${key}@${EMAIL_DOMAIN}`;

const client = new pg.Client({ connectionString: url, application_name: "west4-demo-sing-sing" });
await client.connect();
const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];

try {
  const template = await one(
    "select id, org_id, rule_pack_id, time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where slug = $1",
    [TEMPLATE],
  );
  if (!template) throw new Error("demo-sing-sing: West 4 isn't seeded; run pnpm seed first");

  // 1. The last Sing Sing demo, gone. Replica mode skips the foreign-key and audit triggers, so
  //    every table with a venue_id loses its Sing Sing rows in any order (local databases only).
  await client.query("begin");
  await client.query("set local session_replication_role = replica");
  const old = await one("select id from venues where slug = $1", [SLUG]);
  const oldUsers = (
    await client.query("select id from users where email like $1", [`%@${EMAIL_DOMAIN}`])
  ).rows.map((r) => r.id);
  const columnTables = async (column, without) =>
    (
      await client.query(
        `select c.relname from pg_class c
           join pg_attribute a on a.attrelid = c.oid and a.attname = $1 and not a.attisdropped
          where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace
            and ($2::text is null or not exists (
              select 1 from pg_attribute b where b.attrelid = c.oid and b.attname = $2 and not b.attisdropped))`,
        [column, without],
      )
    ).rows.map((r) => r.relname);
  if (old) {
    for (const t of await columnTables("device_id", "venue_id"))
      await client.query(
        `delete from "${t}" where device_id in (select id from devices where venue_id = $1)`,
        [old.id],
      );
    for (const t of await columnTables("venue_id", null))
      await client.query(`delete from "${t}" where venue_id = $1`, [old.id]);
    await client.query("delete from venues where id = $1", [old.id]);
  }
  if (oldUsers.length > 0) {
    for (const t of await columnTables("user_id", "venue_id"))
      await client.query(`delete from "${t}" where user_id = any($1::uuid[])`, [oldUsers]);
    await client.query("delete from users where id = any($1::uuid[])", [oldUsers]);
  }
  await client.query("commit");

  // 2. The venue, in one transaction with the foreign keys on.
  await client.query("begin");
  const venueId = (
    await one(
      `insert into venues (org_id, name, slug, address, time_zone, day_cutover, rule_pack_id, setup_completed_at)
       values ($1, 'Sing Sing Karaoke Astoria', $2, $3, $4, $5, $6, now()) returning id`,
      [
        template.org_id,
        SLUG,
        JSON.stringify({
          line1: "25-30 Broadway",
          city: "Astoria",
          state: "NY",
          postal_code: "11106",
        }),
        template.time_zone,
        template.day_cutover,
        template.rule_pack_id,
      ],
    )
  ).id;
  await client.query("select set_config('app.venue_id', $1, true)", [venueId]);

  // Rooms 1 to 6, sized like West 4's (placeholders), each available.
  const rooms = (
    await client.query(
      `insert into rooms (venue_id, name, size_tier, capacity_min, capacity_max)
       select $1, name, size_tier, capacity_min, capacity_max from rooms
        where venue_id = $2 and name in ('Room 1','Room 2','Room 3','Room 4','Room 5','Room 6')
       returning id`,
      [venueId, template.id],
    )
  ).rows;
  if (rooms.length !== 6) throw new Error(`demo-sing-sing: expected 6 rooms, made ${rooms.length}`);
  for (const r of rooms)
    await client.query(
      "insert into room_states (venue_id, room_id, state, since) values ($1, $2, 'available', now())",
      [venueId, r.id],
    );

  // Settings: West 4's version in force, with Sing Sing's own choices on top.
  const latest = (
    await client.query(
      `select distinct on (key) key, value, starts_on::text from venue_settings
        where venue_id = $1 order by key, version desc`,
      [template.id],
    )
  ).rows;
  const override = {
    hours: () => ({
      // Sing Sing's website (venue.md): Mon–Wed and Sun 12 PM–12 AM, Thu to 1 AM, Fri–Sat to 3 AM.
      weekly: [
        { day: 0, opens: "12:00", closes: "00:00" },
        { day: 1, opens: "12:00", closes: "00:00" },
        { day: 2, opens: "12:00", closes: "00:00" },
        { day: 3, opens: "12:00", closes: "00:00" },
        { day: 4, opens: "12:00", closes: "01:00" },
        { day: 5, opens: "12:00", closes: "03:00" },
        { day: 6, opens: "12:00", closes: "03:00" },
      ],
      lastCall: null,
    }),
    prices: (v) => ({ ...v, vip: null }),
    deposit: (v) => ({ ...v, on: false, bigParty: null, walkIn: "cardBehindBar" }),
    safety: (v) => ({ ...v, allAgesUntil: "20:00" }),
    kitchen: (v) => ({ ...v, allergyNotice: { en: ALLERGY_EN, es: ALLERGY_ES } }),
    phone: () => ({ callNumber: "+19297397310", textNumber: "+19297397310" }),
    pos: (v) => ({ ...v, layouts: {} }),
    approvals: () => ({ mode: "pin" }),
  };
  for (const row of latest) {
    const value = override[row.key] ? override[row.key](row.value) : row.value;
    const parsed = parseSetting(row.key, value);
    if (!parsed.ok)
      throw new Error(`demo-sing-sing: ${row.key} refused: ${parsed.reasons.join("; ")}`);
    await client.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on) values ($1, $2, 1, $3, $4)`,
      [venueId, row.key, JSON.stringify(parsed.value), row.starts_on],
    );
  }

  // Features: West 4's rows, then Sing Sing's own choices (D124): FEATURES_ON allowed and on,
  // FEATURES_OFF off; the rest as West 4's (or, for a switch West 4 has no row for, its default).
  await client.query(
    `insert into venue_modules (venue_id, module_id, allowed, state)
     select $1, module_id, allowed, state from venue_modules where venue_id = $2`,
    [venueId, template.id],
  );
  for (const [ids, state] of [
    [FEATURES_ON, "on"],
    [FEATURES_OFF, "off"],
  ])
    for (const id of ids)
      await client.query(
        `insert into venue_modules (venue_id, module_id, allowed, state) values ($1, $2, true, $3)
         on conflict (venue_id, module_id) do update set allowed = true, state = excluded.state`,
        [venueId, id, state],
      );
  await client.query(
    `insert into role_permissions (venue_id, role, action, allowed)
     select $1, role, action, allowed from role_permissions where venue_id = $2`,
    [venueId, template.id],
  );
  await client.query(
    `insert into message_templates (venue_id, key, position, category, body, "on")
     select $1, key, position, category, body, "on" from message_templates where venue_id = $2`,
    [venueId, template.id],
  );

  // The guest website: West 4's layout, Sing Sing's own facts, and DEMO wording where the site has none.
  const site = await one(
    "select content from site_versions where venue_id = $1 and status = 'published' order by version desc limit 1",
    [template.id],
  );
  if (site) {
    const content = {
      ...site.content,
      hero: {
        headline: "Sing Sing Karaoke Astoria",
        lead: "DEMO TEXT · private karaoke rooms and a cocktail bar on Broadway, Astoria. Change it in Admin → Website.",
      },
      numbers: [
        { value: "6", text: "private karaoke rooms." },
        { value: "50K+", text: "songs." },
      ],
      songbook: { heading: "50,000+ songs.", songCount: null },
      rooms: { heading: "6 private rooms.", lead: "DEMO TEXT · change it in Admin → Website." },
      findUs: {
        social: [],
        directions: "N or W train to Broadway, about a 3-minute walk west along Broadway.",
      },
      // Sing Sing's website states these two (venue.md); West 4's own rules don't apply here.
      houseRules: [
        "All ages before 8 PM. 21 and over, with a physical ID, after 8 PM.",
        "Walk-ins always welcome at the cocktail bar.",
      ],
      parties: {
        headline: "Private parties",
        lead: "DEMO TEXT · change it in Admin → Website.",
        hosts: [],
        notes: [],
        packagesNote: null,
      },
      hidden: ["singAtTheBar", "parties"],
      photos: [],
    };
    const checked = siteContentSchema.safeParse(content);
    if (!checked.success)
      throw new Error(`demo-sing-sing: website refused: ${checked.error.message}`);
    await client.query(
      `insert into site_versions (venue_id, version, status, content, published_at)
       values ($1, 1, 'published', $2, now())`,
      [venueId, JSON.stringify(content)],
    );
  }

  // The team.
  const authKey = db.parseAuthSecretKey(process.env["AUTH_SECRET_KEY"] ?? db.LOCAL_DEV_AUTH_KEY);
  const membership = {};
  for (const p of PEOPLE) {
    const user = await one("insert into users (name, email) values ($1, $2) returning id", [
      p.name,
      emailOf(p.key),
    ]);
    const m = await one(
      `insert into memberships (venue_id, user_id, role, status, pin_digits, locale)
       values ($1, $2, $3, 'active', $4, 'en') returning id`,
      [venueId, user.id, p.role, p.digits],
    );
    membership[p.key] = m.id;
    if (p.pin)
      await client.query("update memberships set pin_verifier = $2 where id = $1", [
        m.id,
        await db.pinVerifier(authKey, venueId, m.id, p.pin),
      ]);
  }

  // Devices: the two computers and their receipt printers (pair the screens in Admin → Printers &
  // devices), the pretend kitchen network printer (its password is demo-kitchen), and two house
  // drawers open at $300.00 with Andy responsible, as at West 4.
  const device = async (kind, name, extra = {}) =>
    (
      await one(
        `insert into devices (venue_id, kind, name, station, protocol, secret_hash)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [venueId, kind, name, extra.station ?? null, extra.protocol ?? null, extra.secret ?? null],
      )
    ).id;
  const barComputer = await device("bar_computer", "Bar computer");
  const barPrinter = await device("printer", "Bar receipt printer");
  const frontComputer = await device("front_desk", "Front-desk computer");
  const frontPrinter = await device("printer", "Front-desk receipt printer");
  await device("printer", "Kitchen printer (demo)", {
    station: "kitchen",
    protocol: "cloudprnt",
    secret: createHash("sha256").update("demo-kitchen").digest("hex"),
  });
  const businessDate = (
    await one(
      "select starts_on::text as d from venue_settings where venue_id = $1 and key = 'hours'",
      [venueId],
    )
  ).d;
  for (const [name, station, printer, screen] of [
    ["Bar drawer", "bar", barPrinter, barComputer],
    ["Front-desk drawer", "front_desk", frontPrinter, frontComputer],
  ]) {
    const drawer = await one(
      `insert into cash_drawers (venue_id, name, station, printer_device_id) values ($1, $2, $3, $4) returning id`,
      [venueId, name, station, printer],
    );
    await client.query("update devices set cash_drawer_id = $2 where id = $1", [screen, drawer.id]);
    await client.query(
      `insert into drawer_sessions (venue_id, drawer_id, model, responsible_id, state, business_date, opened_at, opening_cents)
       values ($1, $2, 'house', $3, 'open', $4, ($4::date + $5::time) at time zone $6, 30000)`,
      [
        venueId,
        drawer.id,
        membership["andy"],
        businessDate,
        template.day_cutover,
        template.time_zone,
      ],
    );
  }
  await client.query("commit");

  // 5. Sing Sing's menu, through the importer (food on the kitchen, drinks on the bar).
  execFileSync(
    "node",
    [
      path.join(root, "packages/db/dist/import-cli.js"),
      "--venue",
      SLUG,
      "--mapping",
      path.join(root, "docs/venues/sing-sing/import/mapping.json"),
      "--out",
      path.join(root, ".demo-logs/sing-sing-import"),
    ],
    { env: { ...process.env, DATABASE_URL: url }, stdio: ["ignore", "ignore", "inherit"] },
  );
  const menu = await one("select count(*)::int as n from menu_items where venue_id = $1", [
    venueId,
  ]);

  // 6. Invite links for Abhishek and Andy, as demo-local.sh makes West 4's.
  console.log(
    `Seeded Sing Sing Karaoke Astoria: 6 rooms, Kitchen & food on, ${menu.n} menu items.`,
  );
  for (const key of ["abhishek", "andy"]) {
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    await client.query(
      `insert into invites (venue_id, membership_id, token_hash, expires_at)
       values ($1, $2, $3, now() + interval '2 days')`,
      [venueId, membership[key], hash],
    );
    console.log(`Sing Sing invite for ${emailOf(key)}: ${staffUrl}/invite/${token}`);
  }
  console.log(
    "Sing Sing's PIN staff: Maya S. 4071 (bartender), Diego R. 6358 (front desk). " +
      "Guest site: http://localhost:3001/v/singsing",
  );
} catch (error) {
  await client.query("rollback").catch(() => {});
  throw error;
} finally {
  await client.end();
}
