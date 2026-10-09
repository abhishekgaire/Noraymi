/**
 * Design review captures (V-01, V-08): the frozen canvas board beside the built screen, at the same sizes,
 * from a fresh demo seed at 10:41 PM. Off by default; run it with
 *   DESIGN_REVIEW=1 pnpm exec playwright test --project staff design-review
 * The side-by-side PNGs land in docs/design-review/v08/ for the founder (v01/ holds V-01's).
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { freshNight } from "./night.js";

const OUT = "docs/design-review/v08";
const CANVAS_PORT = 8765;
const ANDY = "andy@demo.west4.local";

test.skip(!process.env["DESIGN_REVIEW"], "design review captures run only with DESIGN_REVIEW=1");

let canvas: ChildProcess | undefined;
test.beforeAll(async () => {
  canvas = spawn("python3", ["-m", "http.server", String(CANVAS_PORT)], {
    cwd: "design/canvas",
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://localhost:${CANVAS_PORT}/boards.json`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});
test.afterAll(() => {
  canvas?.kill();
});

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

/** Two screenshots side by side on one dark sheet, each under its label. */
async function sideBySide(page: Page, left: Buffer, right: Buffer, file: string) {
  const sheet = await page.context().newPage();
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

test("V-08 · the Board beside Board.dc.html at 1280, and the phone beside Staff.dc.html at 390", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });
  await freshNight();
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } });
    await page.reload();
    await expect(page.getByRole("listitem", { name: "Room 9", exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const canvasPage = await page.context().newPage();
    const shoot = async (board: string, width: number, height: number, fullPage: boolean) => {
      await canvasPage.setViewportSize({ width, height });
      await canvasPage.goto(`http://localhost:${CANVAS_PORT}/${board}`);
      await canvasPage.waitForLoadState("networkidle");
      await canvasPage.waitForTimeout(800);
      return canvasPage.screenshot({ fullPage });
    };

    // Desktop: the front-desk computer's 1280 × 800.
    const canvasDesk = await shoot("Board.dc.html", 1280, 800, false);
    const builtDeskFull = await page.screenshot({ fullPage: true });
    await sideBySide(page, canvasDesk, builtDeskFull, "board-desktop-1280-full.png");
    // Room 9 open in the side panel, as the canvas shows it.
    await page.getByRole("listitem", { name: "Room 9", exact: true }).getByRole("button").click();
    await expect(page.getByRole("region", { name: "Room 9", exact: true })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    const builtDesk = await page.screenshot();
    await sideBySide(page, canvasDesk, builtDesk, "board-desktop-1280-panel.png");

    // Phone: 390 wide. The canvas's phone home is Staff.dc.html (M · Staff portal · tonight).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole("region", { name: /^Room by room/ })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const canvasPhone = await shoot("Staff.dc.html", 390, 844, false);
    const builtPhone = await page.screenshot();
    await sideBySide(page, canvasPhone, builtPhone, "board-phone-390.png");
    const builtPhoneFull = await page.screenshot({ fullPage: true });
    const canvasPhoneFull = await shoot("Staff.dc.html", 390, 844, true);
    await sideBySide(page, canvasPhoneFull, builtPhoneFull, "board-phone-390-full.png");
    expect(readFileSync(`${OUT}/board-phone-390.png`).length).toBeGreaterThan(0);
  } finally {
    await db.end();
  }
});
