import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { setModuleAllowed, setModuleState, withVenue } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, moduleIds, modules, type ModuleId } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { route } from "../http/conventions.js";
import type { Principal } from "../http/principal.js";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let pool: pg.Pool;

const west4On: ModuleId[] = [
  "website",
  "online_booking",
  "waitlist",
  "rooms",
  "room_ordering",
  "bar_screen",
  "bar_tabs",
  "bar_mode",
  "packages",
  "guest_texts",
  "marketing_texts",
  "team",
  "safety",
  "reports",
];

const get = (path: string) => app.inject({ method: "GET", url: `/v1/venues/${v.venueA}${path}` });
const patch = (id: string, payload: unknown) =>
  app.inject({ method: "PATCH", url: `/v1/venues/${v.venueA}/modules/${id}`, payload });
const stateOfA = async (id: string) =>
  (await get("/modules")).json().modules.find((m: { id: string }) => m.id === id).state as string;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
  await withVenue(pool, { venueId: v.venueA }, async (c) => {
    for (const id of west4On) {
      await setModuleAllowed(c, v.venueA, id, true, undefined);
      await setModuleState(c, v.venueA, id, "on", undefined);
    }
    await setModuleAllowed(c, v.venueA, "song_system", true, undefined);
  });
  const andy: Principal = {
    kind: "user",
    userId: v.ownerA,
    session: "passkey",
    memberships: [{ venueId: v.venueA, membershipId: v.membershipA, role: "owner" }],
  };
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({
    config,
    clock: new FrozenClock(SEED_NOW),
    authenticators: [async () => andy],
    eventsPollMs: 100,
    moduleCacheMs: 0,
    extraRoutes: (a) => {
      // One fixture route per switchable module, plus a creation route and an exempt guest route.
      for (const m of modules.filter((x) => !x.core)) {
        a.get(
          `/v1/venues/:venueId/fixture/${m.id}`,
          { config: route({ principals: ["owner_manager"], module: m.id }) },
          async () => ({ module: m.id }),
        );
      }
      a.post(
        "/v1/venues/:venueId/fixture/online_booking/new",
        {
          config: route({
            principals: ["owner_manager"],
            module: "online_booking",
            createsNewWork: true,
            idempotency: "none",
          }),
        },
        async () => ({ created: true }),
      );
      a.get(
        "/v1/venues/:venueId/fixture/online_booking/existing",
        {
          config: route({
            principals: ["owner_manager"],
            module: "online_booking",
            exemptWhenOff: true,
          }),
        },
        async () => ({ ok: true }),
      );
    },
  });
  await app.ready();
});

afterAll(async () => {
  await pool.end();
  await app.close();
  await db.drop();
});

describe("modules", () => {
  it("GET /modules lists every module with its state, needs and what it hides; core ones are on and can't be turned off", async () => {
    const res = await get("/modules");
    expect(res.statusCode).toBe(200);
    const list = res.json().modules as {
      id: string;
      state: string;
      core: boolean;
      needs: string[];
    }[];
    expect(list.map((m) => m.id)).toEqual(moduleIds);
    expect(list.find((m) => m.id === "payments")).toMatchObject({ state: "on", core: true });
    expect(list.find((m) => m.id === "room_ordering")).toMatchObject({
      state: "on",
      needs: ["rooms", "bar_screen"],
    });
    const core = await patch("payments", { state: "off" });
    expect(core.statusCode).toBe(400);
    expect(core.json().error.message).toContain("core module");
  });

  it("turning off Bar screen & tickets asks 'Room orders would have nowhere to ring…'; yes turns both off, and no changes nothing", async () => {
    const ask = await patch("bar_screen", { state: "off" });
    expect(ask.statusCode).toBe(200);
    expect(ask.json()).toMatchObject({
      applied: false,
      needs_confirm: true,
      turns_off: ["room_ordering"],
      question: "Room orders would have nowhere to ring. Turn off Ordering from the room too?",
    });
    expect(await stateOfA("bar_screen")).toBe("on");
    expect(await stateOfA("room_ordering")).toBe("on");
    const yes = await patch("bar_screen", { state: "off", confirm: true });
    expect(yes.json()).toMatchObject({ applied: true, changed: ["bar_screen", "room_ordering"] });
    expect(await stateOfA("bar_screen")).toBe("off");
    expect(await stateOfA("room_ordering")).toBe("off");
  });

  it("Ordering from the room can't be turned on while Bar screen & tickets is off", async () => {
    const res = await patch("room_ordering", { state: "on" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("This needs Bar screen & tickets to be on first.");
    expect((await patch("bar_screen", { state: "on" })).json()).toMatchObject({
      applied: true,
      changed: ["bar_screen"],
    });
    expect((await patch("room_ordering", { state: "on" })).json()).toMatchObject({
      applied: true,
      changed: ["room_ordering"],
    });
  });

  it("turning off Rooms & room clock lists 'These turn off with it: Online booking & deposits, Ordering from the room, Packages & specials'", async () => {
    const ask = await patch("rooms", { state: "off" });
    expect(ask.json()).toMatchObject({
      applied: false,
      needs_confirm: true,
      turns_off: ["online_booking", "room_ordering", "packages"],
      question:
        "These turn off with it: Online booking & deposits, Ordering from the room, Packages & specials",
    });
    expect(await stateOfA("rooms")).toBe("on");
  });

  it("with any module off, every route registered to it answers 404 module_off; stopping refuses only new work; exempt guest routes keep working", async () => {
    expect((await get("/fixture/reports")).statusCode).toBe(200);
    await patch("reports", { state: "off", confirm: true });
    const off = await get("/fixture/reports");
    expect(off.statusCode).toBe(404);
    expect(off.json().error.code).toBe("module_off");
    expect((await get("/fixture/song_system")).json().error.code).toBe("module_off");
    await patch("reports", { state: "on" });
    expect((await get("/fixture/reports")).statusCode).toBe(200);

    await patch("online_booking", { state: "stopping", confirm: true });
    expect((await get("/fixture/online_booking")).statusCode).toBe(200);
    const create = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/fixture/online_booking/new`,
      payload: {},
    });
    expect(create.json().error.code).toBe("module_off");
    await patch("online_booking", { state: "off", confirm: true });
    expect((await get("/fixture/online_booking")).json().error.code).toBe("module_off");
    expect((await get("/fixture/online_booking/existing")).statusCode).toBe(200);
    await patch("online_booking", { state: "on" });
  });

  it("a module whose allowed is false can't be turned on from Admin", async () => {
    const res = await patch("kitchen", { state: "on" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain("plan");
    expect(await stateOfA("kitchen")).toBe("off");
  });

  it("GET /flags reads the venue's switches", async () => {
    expect((await get("/flags")).json()).toMatchObject({ flags: {} });
  });
});
