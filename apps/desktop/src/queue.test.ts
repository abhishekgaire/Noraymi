import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { offlineCodeAt, printedOfflineCodes } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { DesktopCache } from "./cache.js";
import { SealedStore, type Sealer } from "./keychain.js";
import { hmac, QueueMode } from "./queue.js";

/**
 * Queue mode on the bar computer (M8-04), on the simulated clock: Sat 2:41 AM
 * on Fri Sep 25's business date, offline. The code is checked here; queued
 * rounds survive the app being killed and opened again, and the cutover.
 */
const KEY = "c".repeat(64);
const NEW_YORK = { timeZone: "America/New_York", dayCutover: "06:00" };
const BAR = "3f0c3c2e-0c5e-4a43-9a43-1c1c2f5a7f10";
const SECRET = "ab".repeat(32);
const AT = Temporal.Instant.from("2026-09-26T06:41:00Z");
const sealer: Sealer = {
  isAvailable: () => true,
  seal: (plain) => Buffer.from(Buffer.from(plain).map((b) => b ^ 0x5a)),
  open: (sealed) => Buffer.from(sealed.map((b) => b ^ 0x5a)).toString(),
};
const scope = { deviceId: BAR, ...NEW_YORK };
const round = (over: Record<string, unknown> = {}) => ({
  order_id: randomUUID(),
  tab_id: "tab-luis",
  check_id: "check-luis",
  tab_name: "Luis M.",
  staff: { membership_id: "m-maya", name: "Maya S." },
  lines: [{ variant_id: "v-jager", name: "Jäger Bomb", qty: 1, unit_cents: 1200, alcohol: true }],
  ...over,
});

describe("queue mode", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const boot = (fresh = true) => {
    if (fresh) dir = mkdtempSync(join(tmpdir(), "west4-queue-"));
    const cache = DesktopCache.open(join(dir, "cache.sqlite"), KEY, NEW_YORK);
    const queue = new QueueMode(
      new SealedStore(join(dir, "offline.secret"), sealer),
      () => cache,
      () => cache.venueClock(),
    );
    return { cache, queue };
  };

  it("keeps the secret sealed and never hands it back, only a fingerprint for this device", () => {
    const { queue, cache } = boot();
    expect(queue.fingerprint(BAR)).toBeNull();
    queue.setSecret(BAR, SECRET);
    expect(queue.fingerprint(BAR)).toMatch(/^[0-9a-f]{32}$/);
    expect(queue.fingerprint("another-device")).toBeNull();
    expect(readFileSync(join(dir, "offline.secret"), "latin1")).not.toContain(SECRET);
    expect(() => queue.setSecret(BAR, "not-hex")).toThrow(/refused/);
    cache.close();
  });

  it("opens with this computer's code, for 4 hours, and ends when the connection returns", () => {
    const { queue, cache } = boot();
    queue.setSecret(BAR, SECRET);
    expect(queue.state(AT).open).toBe(false);
    const opened = queue.unlock(AT, offlineCodeAt(hmac, SECRET, scope, AT));
    expect(opened).toMatchObject({
      open: true,
      kind: "time",
      ends_at: "2026-09-26T10:41:00Z",
    });
    expect(queue.state(AT.add({ hours: 3, minutes: 59 })).open).toBe(true);
    expect(queue.state(AT.add({ hours: 4 })).open).toBe(false);
    // Closed by itself: it stays closed.
    expect(queue.state(AT).open).toBe(false);
    queue.unlock(AT, offlineCodeAt(hmac, SECRET, scope, AT));
    queue.end();
    expect(queue.state(AT).open).toBe(false);
    cache.close();
  });

  it("a wrong or expired code, the front desk's, or a printed code for another night opens nothing", () => {
    const { queue, cache } = boot();
    expect(queue.unlock(AT, "123456")).toMatchObject({ open: false, refused: "not_set_up" });
    queue.setSecret(BAR, SECRET);
    const wrong = offlineCodeAt(hmac, SECRET, scope, AT) === "000000" ? "000001" : "000000";
    expect(queue.unlock(AT, wrong)).toMatchObject({ open: false, refused: "wrong" });
    const old = offlineCodeAt(hmac, SECRET, scope, AT.subtract({ minutes: 15 }));
    expect(queue.unlock(AT, old).open).toBe(false);
    const desk = offlineCodeAt(hmac, SECRET, { ...scope, deviceId: "front-desk" }, AT);
    expect(queue.unlock(AT, desk).open).toBe(false);
    expect(
      queue.unlock(AT, printedOfflineCodes(hmac, SECRET, "front-desk", "2026-09-25")[0]!).open,
    ).toBe(false);
    expect(queue.unlock(AT, printedOfflineCodes(hmac, SECRET, BAR, "2026-09-24")[0]!).open).toBe(
      false,
    );
    expect(queue.state(AT).open).toBe(false);
    cache.close();
  });

  it("a printed code for tonight opens it once", () => {
    const { queue, cache } = boot();
    queue.setSecret(BAR, SECRET);
    const card = printedOfflineCodes(hmac, SECRET, BAR, "2026-09-25");
    expect(queue.unlock(AT, card[2]!)).toMatchObject({ open: true, kind: "printed" });
    queue.end();
    expect(queue.unlock(AT, card[2]!)).toMatchObject({ open: false, refused: "used" });
    expect(queue.unlock(AT, card[3]!).open).toBe(true);
    cache.close();
  });

  it("queues rounds only while open, and none is lost when the app is killed and opened again", () => {
    const first = boot();
    first.queue.setSecret(BAR, SECRET);
    expect(() => first.queue.add(AT, round())).toThrow(/isn't open/);
    first.queue.unlock(AT, offlineCodeAt(hmac, SECRET, scope, AT));
    const queued = first.queue.add(AT, round());
    expect(queued).toMatchObject({
      business_date: "2026-09-25",
      tab_name: "Luis M.",
      staff: { name: "Maya S." },
      cash_note: null,
    });
    expect(() => first.queue.add(AT, { ...round(), order_id: queued.order_id })).toThrow(/already/);
    expect(() => first.queue.add(AT, round({ lines: [] }))).toThrow(/refused/);
    expect(() => first.queue.add(AT, round({ order_id: "not-a-uuid" }))).toThrow(/refused/);
    // Killed mid-outage: nothing closed cleanly. Opened again, the round and queue mode are still there.
    const again = boot(false);
    expect(again.queue.list().map((o) => o.order_id)).toEqual([queued.order_id]);
    expect(again.queue.state(AT.add({ minutes: 1 })).open).toBe(true);
    // The 6:00 AM cutover wipes the night's reads but keeps the queued rounds for the replay.
    again.cache.put(AT, "read", "/v1/venues/x/tabs", { tabs: [] });
    expect(again.cache.wipeIfPastCutover(Temporal.Instant.from("2026-09-26T10:00:00Z"))).toBe(true);
    expect(again.cache.get("read", "/v1/venues/x/tabs")).toBeNull();
    expect(again.queue.list()).toHaveLength(1);
    expect(readFileSync(join(dir, "cache.sqlite"), "latin1")).not.toContain("Luis M.");
    first.cache.close();
    again.cache.close();
  });
  it("drops only the rounds the server answered on replay (M8-05)", () => {
    const { cache, queue } = boot();
    queue.setSecret(BAR, SECRET);
    queue.unlock(AT, offlineCodeAt(hmac, SECRET, scope, AT));
    const a = queue.add(AT, round());
    const b = queue.add(AT, round());
    expect(queue.settle([a.order_id.toUpperCase(), "not-a-uuid", randomUUID()])).toBe(1);
    expect(queue.list().map((o) => o.order_id)).toEqual([b.order_id]);
    expect(queue.settle("nope")).toBe(0);
    expect(queue.settle([b.order_id])).toBe(1);
    expect(queue.list()).toEqual([]);
    cache.close();
  });
});
