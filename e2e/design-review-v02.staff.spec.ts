/**
 * Design review captures for V-02 (the staff phone screens): each frozen canvas board beside the built
 * screen at 390 wide, from a fresh demo seed at 10:41 PM. Off by default; run it with
 *   DESIGN_REVIEW=1 pnpm exec playwright test --project staff design-review-v02
 * The side-by-side PNGs land in docs/design-review/v02/. DESIGN_REVIEW_API and DESIGN_REVIEW_CANVAS_PORT
 * point it at another API and canvas port (a second stack on its own database).
 */
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import pg from "pg";
import { SEED_COMMAND, SEED_INSTANT } from "./night.js";
import { API as STACK_API, CANVAS, DB, ports } from "./stack.js";

const OUT = "docs/design-review/v02";
const CANVAS_PORT = ports.canvas;
const API = process.env["DESIGN_REVIEW_API"] ?? STACK_API;
const ANDY = "andy@demo.west4.local";
const W = 390;
const H = 844;

test.skip(!process.env["DESIGN_REVIEW"], "design review captures run only with DESIGN_REVIEW=1");

let canvas: ChildProcess | undefined;
test.beforeAll(async () => {
  canvas = spawn("python3", ["-m", "http.server", String(CANVAS_PORT)], {
    cwd: "design/canvas",
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${CANVAS}/boards.json`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});
test.afterAll(() => {
  canvas?.kill();
});

async function setClock(iso: string = SEED_INSTANT) {
  const r = await fetch(`${API}/v1/ops/clock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server_time: iso }),
  });
  expect(r.ok).toBe(true);
}

async function enrolPasskey(page: Page, request: APIRequestContext, db: pg.Client) {
  await db.query(
    "delete from auth_credentials where user_id = (select id from users where lower(email) = $1)",
    [ANDY],
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  expect(
    (await request.post("/v1/auth/enroll", { data: { step: "start", email: ANDY } })).ok(),
  ).toBe(true);
  const job = await db.query<{ payload: { data: { code: string } } }>(
    "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
    [ANDY],
  );
  const code = job.rows[0]!.payload.data.code;
  const options = (await (
    await request.post("/v1/auth/enroll", {
      data: { step: "passkey_options", email: ANDY, code },
    })
  ).json()) as { options: unknown };
  const registration = await page.evaluate(async (opts) => {
    const { PublicKeyCredential } = window as unknown as {
      PublicKeyCredential: {
        parseCreationOptionsFromJSON(o: unknown): PublicKeyCredentialCreationOptions;
      };
    };
    const cred = (await navigator.credentials.create({
      publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(opts),
    })) as PublicKeyCredential & { toJSON(): unknown };
    return cred.toJSON();
  }, options.options);
  const enrolled = await request.post("/v1/auth/enroll", {
    data: {
      step: "passkey_finish",
      email: ANDY,
      code,
      credential: registration,
      name: "Design review",
      client: "desktop",
    },
  });
  expect(enrolled.status(), await enrolled.text()).toBe(201);
}

async function pairingCode(db: pg.Client): Promise<string> {
  const code = randomBytes(4).toString("hex").toUpperCase();
  const venue = await db.query<{ id: string }>("select id from venues limit 1");
  await db.query(
    "insert into device_pairing_codes (venue_id, code_hash, kind, name, expires_at) values ($1, $2, 'bar_computer', 'Bar computer', now() + interval '1 hour')",
    [venue.rows[0]!.id, createHash("sha256").update(code).digest("hex")],
  );
  return code;
}

/** Two screenshots side by side on one dark sheet, each under its label. */
async function sideBySide(browser: Browser, left: Buffer, right: Buffer, file: string) {
  const sheet = await browser.newPage();
  const img = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;
  await sheet.setContent(
    `<body style="margin:0;background:#2a2830;font:600 16px system-ui;color:#f4f1ea">
      <div style="display:flex;gap:24px;padding:16px;align-items:flex-start;width:max-content">
        <figure style="margin:0"><figcaption style="padding:0 0 8px">Canvas (frozen v39)</figcaption><img src="${img(left)}"></figure>
        <figure style="margin:0"><figcaption style="padding:0 0 8px">Built (staff app)</figcaption><img src="${img(right)}"></figure>
      </div></body>`,
  );
  await sheet.waitForLoadState("load");
  await sheet.screenshot({ path: `${OUT}/${file}`, fullPage: true });
  await sheet.close();
}

test("V-02 · the staff phone screens beside their canvas boards at 390", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  mkdirSync(OUT, { recursive: true });
  execSync(SEED_COMMAND, { stdio: ["ignore", "ignore", "pipe"] });
  await setClock();
  const db = new pg.Client({
    connectionString: DB,
  });
  await db.connect();
  const canvasPage = await browser.newPage();
  const board = async (
    file: string,
    click?: string,
    fullPage = false,
    prepare?: (p: Page) => Promise<void>,
  ) => {
    await canvasPage.setViewportSize({ width: W, height: H });
    await canvasPage.goto(`${CANVAS}/${file}`);
    await canvasPage.waitForLoadState("networkidle");
    await canvasPage.waitForTimeout(600);
    if (click) await canvasPage.getByRole("button", { name: click, exact: true }).first().click();
    if (prepare) await prepare(canvasPage);
    await canvasPage.waitForTimeout(300);
    return canvasPage.screenshot({ fullPage });
  };
  const built = async (p: Page, fullPage = false) => {
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(300);
    return p.screenshot({ fullPage });
  };
  try {
    await db.query("update memberships set locale = 'en'");

    // Pin: the bar computer's sign-in (names), then Maya's PIN pad.
    const bar = await browser.newContext({ viewport: { width: W, height: H } });
    const barPage = await bar.newPage();
    await barPage.goto(new URL("/sign-in", test.info().project.use.baseURL).toString());
    await barPage.getByRole("button", { name: "Pair this screen" }).click();
    await barPage.getByLabel("Pairing code from Admin → Devices").fill(await pairingCode(db));
    await barPage.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(barPage.getByRole("heading", { level: 1 })).toHaveText("Staff sign-in");
    await sideBySide(browser, await board("Pin.dc.html"), await built(barPage), "pin-390.png");
    await barPage.getByRole("button", { name: /^Maya/ }).click();
    await expect(barPage.locator(".keypad")).toBeVisible();
    await sideBySide(
      browser,
      await board("Pin.dc.html", undefined, false, async (p) => {
        await p.getByRole("button", { name: /^Maya S\., / }).click();
      }),
      await built(barPage),
      "pin-pad-390.png",
    );
    // The bar computer itself is a desktop screen: the same centred column at 1280.
    await barPage.getByRole("button", { name: "Back" }).click();
    await barPage.setViewportSize({ width: 1280, height: 800 });
    await sideBySide(
      browser,
      await board("Pin.dc.html"),
      await built(barPage),
      "pin-desktop-1280.png",
    );
    await bar.close();

    // The staff phone, signed in as Andy.
    await page.setViewportSize({ width: W, height: H });
    await page.goto("/");
    await enrolPasskey(page, request, db);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    await page.goto("/today");
    await expect(page.getByRole("list", { name: "Bookings tonight" })).toBeVisible();
    await sideBySide(
      browser,
      await board("Staff.dc.html", "List"),
      await built(page),
      "today-390.png",
    );
    await sideBySide(
      browser,
      await board("Staff.dc.html", "List", true),
      await built(page, true),
      "today-390-full.png",
    );

    await page.goto("/waitlist");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await sideBySide(
      browser,
      await board("Staff.dc.html", "Waitlist"),
      await built(page),
      "waitlist-390.png",
    );

    await page.goto("/runs");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Runs");
    await expect(page.locator(".run").first()).toBeVisible();
    await sideBySide(
      browser,
      await board("Staff.dc.html", undefined, false, async (p) => {
        await p.getByRole("button", { name: /^Runs/ }).first().click();
      }),
      await built(page),
      "runs-390.png",
    );

    await page.goto("/tips");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await sideBySide(
      browser,
      await board("Staff.dc.html", "Tips"),
      await built(page),
      "tips-390.png",
    );

    const room9 = await db.query<{ id: string }>("select id from rooms where name = 'Room 9'");
    await page.goto(`/room/${room9.rows[0]!.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Room 9");
    await sideBySide(browser, await board("Room.dc.html"), await built(page), "room-390.png");
    await sideBySide(
      browser,
      await board("Room.dc.html", undefined, true),
      await built(page, true),
      "room-390-full.png",
    );
  } finally {
    await canvasPage.close();
    await db.end();
  }
});
