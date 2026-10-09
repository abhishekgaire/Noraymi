/**
 * Design review captures (V-04): the bar screens beside their frozen canvas boards, at the boards'
 * sizes, from a fresh demo seed at 10:41 PM. Off by default; run it with
 *   DESIGN_REVIEW=1 pnpm exec playwright test --project staff design-review-v04
 * The seed loads into DATABASE_URL and the clock moves through the staff app's own /v1, so the run
 * can point at its own database and ports. The side-by-side PNGs land in docs/design-review/v04/.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import pg from "pg";
import { SEED_COMMAND, SEED_INSTANT } from "./night.js";
import { CANVAS, DB, ports } from "./stack.js";

const OUT = "docs/design-review/v04";
const CANVAS_PORT = ports.canvas;
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

test("V-04 · the bar POS beside Rail.dc.html at 1280 × 800, bar orders beside Bar.dc.html at 900 × 640", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  mkdirSync(OUT, { recursive: true });
  execSync(SEED_COMMAND, { stdio: ["ignore", "ignore", "pipe"] });
  expect((await request.post("/v1/ops/clock", { data: { server_time: SEED_INSTANT } })).ok()).toBe(
    true,
  );
  const db = new pg.Client({
    connectionString: DB,
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

    const canvasPage = await page.context().newPage();
    const shoot = async (board: string, width: number, height: number) => {
      await canvasPage.setViewportSize({ width, height });
      await canvasPage.goto(`${CANVAS}/${board}`);
      await canvasPage.waitForLoadState("networkidle");
      await canvasPage.waitForTimeout(800);
      return canvasPage.screenshot();
    };

    // The bar POS: the bar computer's 1280 × 800, with Jess P.'s tab picked as the canvas has it.
    await page.goto("/bar");
    await expect(page.getByRole("tablist", { name: "Sections" })).toBeVisible();
    await page
      .getByRole("list", { name: "Bar tabs" })
      .getByRole("button", { name: /^Jess P\./ })
      .click();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    const canvasRail = await shoot("Rail.dc.html", 1280, 800);
    await sideBySide(page, canvasRail, await page.screenshot(), "rail-1280.png");
    await sideBySide(
      page,
      canvasRail,
      await page.screenshot({ fullPage: true }),
      "rail-1280-full.png",
    );

    // The bar orders screen: its own 900 × 640 window at the bar.
    await page.setViewportSize({ width: 900, height: 640 });
    await page.goto("/bar-orders");
    await expect(page.getByRole("heading", { name: "Waiting for you" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    const canvasBar = await shoot("Bar.dc.html", 900, 640);
    await sideBySide(page, canvasBar, await page.screenshot(), "bar-orders-900.png");
    await sideBySide(
      page,
      canvasBar,
      await page.screenshot({ fullPage: true }),
      "bar-orders-900-full.png",
    );

    // The song queue in bar mode has no canvas board (screens N27); it is drawn in the Rail's style.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/song-queue");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    await sideBySide(
      page,
      canvasRail,
      await page.screenshot({ fullPage: true }),
      "song-queue-1280.png",
    );

    // In Spanish, the longer language, nothing is cut off and the menu buttons keep 115 × 100.
    await page.getByRole("button", { name: "Switch to Español" }).click();
    for (const [path, width, height] of [
      ["/bar", 1280, 800],
      ["/bar", 390, 844],
      ["/bar-orders", 900, 640],
      ["/song-queue", 1280, 800],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForTimeout(300);
      const clipped = await page.evaluate(() => {
        const out: string[] = [];
        if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push("page");
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
          if (!el.textContent?.trim()) continue;
          const s = getComputedStyle(el);
          if (s.display === "none" || el.dataset["scroll"] === "x") continue;
          if (
            (s.overflowX !== "visible" || s.textOverflow === "ellipsis") &&
            el.scrollWidth > el.clientWidth + 1
          )
            out.push(`${el.tagName}.${el.className}`);
        }
        for (const b of Array.from(document.querySelectorAll<HTMLElement>(".rail-grid .slot"))) {
          const r = b.getBoundingClientRect();
          if (r.width < 115 || r.height < 100) out.push(`slot ${r.width}×${r.height}`);
        }
        return out;
      });
      expect(clipped, `${path} at ${width}`).toEqual([]);
    }
  } finally {
    await db.end();
  }
});
