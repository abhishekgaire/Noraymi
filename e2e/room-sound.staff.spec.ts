import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { freshNight } from "./night.js";
import { DB } from "./stack.js";

/**
 * P-05 · Sound when a room's time is up. A browser paired as the bar computer, locked at the seed's
 * 10:41 PM: Room 3 is amber and Rooms 7 and 10 are red, so one sound plays while it's locked. Their
 * names show in the "Time's up" strip once someone signs in (U-18: in the shell's bands, never on
 * the lock screen), in the tiles' words, until tapped (which opens the room) or Clear all. A reload
 * plays nothing again; switched off, nothing plays or shows. Web Audio is replaced by a counter, so
 * each `new AudioContext()` is one sound.
 */
async function pairingCode(db: pg.Client): Promise<string> {
  const code = randomBytes(4).toString("hex").toUpperCase();
  const venue = await db.query<{ id: string }>("select id from venues where slug = 'west4karaoke'");
  await db.query(
    "insert into device_pairing_codes (venue_id, code_hash, kind, name, expires_at) values ($1, $2, 'bar_computer', 'Bar computer', now() + interval '1 hour')",
    [venue.rows[0]!.id, createHash("sha256").update(code).digest("hex")],
  );
  return code;
}

/** A new version of the venue's `alerts`, as Admin → Alerts & rules saves it. */
async function saveAlerts(db: pg.Client, patch: object): Promise<void> {
  await db.query(
    `insert into venue_settings (venue_id, key, version, value, starts_on)
     select s.venue_id, s.key, s.version + 1, s.value - 'roomSound' - 'roomSoundVolume' || $1::jsonb, s.starts_on
       from venue_settings s join venues v on v.id = s.venue_id
      where v.slug = 'west4karaoke' and s.key = 'alerts'
      order by s.version desc limit 1`,
    [JSON.stringify(patch)],
  );
}

const sounds = (page: Page) => page.evaluate(() => (window as { __sounds?: number }).__sounds ?? 0);

/** Waits for the bar computer's next board read to come back and be handled. */
async function nextBoardRead(page: Page): Promise<void> {
  await page.waitForResponse((r) => /\/v1\/venues\/[^/]+\/board$/.test(r.url()) && r.ok());
  await page.waitForTimeout(300);
}

test("P-05 · one sound per room per step on the bar computer, the Time's up strip once signed in, a tap opens the room, Clear all, a reload doesn't replay it, off plays nothing", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await freshNight();
  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  try {
    await db.query("update memberships set locale = 'en'");
    await page.addInitScript(() => {
      const w = window as unknown as { __sounds: number; AudioContext: unknown };
      w.__sounds = 0;
      w.AudioContext = class {
        currentTime = 0;
        destination = {};
        constructor() {
          w.__sounds += 1;
        }
        createOscillator() {
          return { frequency: {}, connect: (n: unknown) => n, start() {}, stop() {} };
        }
        createGain() {
          return { gain: {}, connect: (n: unknown) => n };
        }
        close() {
          return Promise.resolve();
        }
      };
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Pair this screen" }).click();
    await page.getByLabel("Pairing code from Admin → Devices").fill(await pairingCode(db));
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff sign-in");

    // Locked at 10:41 PM: one sound for all three within one 15-second check, and no names on the
    // lock screen (U-18): the "Time's up" strip lives in the shell's bands.
    await expect.poll(() => sounds(page), { timeout: 20_000 }).toBe(1);
    await expect(page.getByTestId("room-sound")).toHaveCount(0);

    // Maya signs in: the strip is in the bands, each room in its tile's words.
    await page.getByRole("button", { name: /Maya S\./ }).click();
    for (const digit of "4071")
      await page.locator(".keypad").getByRole("button", { name: digit, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bar POS");
    const box = page.getByRole("region", { name: "Time's up" });
    await expect(page.locator(".bands").getByTestId("room-sound")).toBeVisible();
    await expect(
      box.getByRole("button", { name: /^Room 3 · (Wrap up|In room) · \d+ min left$/ }),
    ).toBeVisible();
    await expect(
      box.getByRole("button", { name: "Room 7 · Needed now · 11 min past" }),
    ).toBeVisible();
    await expect(
      box.getByRole("button", { name: "Room 10 · Staying · 41 min past" }),
    ).toBeVisible();
    expect(await sounds(page)).toBe(1);
    const height = await box
      .getByRole("button")
      .first()
      .evaluate((b) => b.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(44);

    // A tap on Room 3 clears it and opens its panel on the board; the next read neither brings it
    // back nor plays again.
    await box.getByRole("button", { name: /^Room 3/ }).click();
    await expect(page).toHaveURL(/\/tonight$/);
    await expect(page.getByRole("region", { name: "Room 3", exact: true })).toBeVisible();
    await expect(box.getByRole("button", { name: /^Room 3/ })).toHaveCount(0);

    // A reload plays nothing again; Rooms 7 and 10 wait for their tap.
    await page.reload();
    await nextBoardRead(page);
    await expect(box.getByRole("button", { name: /^Room 7/ })).toBeVisible();
    await expect(box.getByRole("button", { name: /^Room 3/ })).toHaveCount(0);
    expect(await sounds(page)).toBe(0);

    // Clear all: the strip goes, and the next read doesn't bring it back.
    await box.getByRole("button", { name: "Clear all" }).click();
    await expect(box).toHaveCount(0);
    await nextBoardRead(page);
    await expect(box).toHaveCount(0);
    expect(await sounds(page)).toBe(0);

    // Switched off: a computer that has heard nothing yet plays and shows nothing.
    await saveAlerts(db, { roomSound: false });
    await page.evaluate(() => localStorage.removeItem("west4.roomSound"));
    await page.reload();
    await nextBoardRead(page);
    await expect(box).toHaveCount(0);
    expect(await sounds(page)).toBe(0);

    // Back on, as the seed has it.
    await saveAlerts(db, {});
  } finally {
    await db.end();
  }
});
