import { expect, test } from "@playwright/test";

test("the API answers /v1/health", async ({ request }) => {
  const response = await request.get("/v1/health");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { ok: boolean; server_time: string };
  expect(body.ok).toBe(true);
  expect(body.server_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test("after a fresh seed load, server_time is Fri Sep 25, 2026, 10:41 PM in New York", async ({
  request,
}) => {
  const body = (await (await request.get("/v1/health")).json()) as { server_time: string };
  // The simulated clock ticks on from 10:41:00 PM, so the minutes may have moved a little.
  expect(body.server_time).toMatch(/^2026-09-25T22:4\d:\d{2}-04:00$/);
});

/**
 * M1-19: Andy enrols a passkey with Playwright's virtual authenticator, signs in
 * with it, and opens Admin. The page is the API's own origin (localhost:3000),
 * which the API accepts as a passkey origin in the smoke run; the staff app's
 * sign-in screen arrives in M1-26. The emailed code is read from the job the API
 * queued, since the smoke run starts no worker.
 */
test("Andy enrols a passkey, signs in with it and opens Admin", async ({ page, request }) => {
  const pg = await import("pg");
  const db = new pg.default.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    const email = "andy@demo.west4.local";
    // Andy's seed row has a demo authenticator; the first passkey by email needs an account with no credential yet.
    await db.query(
      "delete from auth_credentials where user_id = (select id from users where lower(email) = $1)",
      [email],
    );

    const client = await page.context().newCDPSession(page);
    await client.send("WebAuthn.enable");
    await client.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.goto("http://localhost:3000/v1/health");

    expect((await request.post("/v1/auth/enroll", { data: { step: "start", email } })).ok()).toBe(
      true,
    );
    const job = await db.query<{ payload: { data: { code: string } } }>(
      "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
      [email],
    );
    const code = job.rows[0]!.payload.data.code;

    const options = (await (
      await request.post("/v1/auth/enroll", { data: { step: "passkey_options", email, code } })
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
        email,
        code,
        credential: registration,
        name: "Smoke test",
        client: "desktop",
      },
    });
    expect(enrolled.status(), await enrolled.text()).toBe(201);

    const start = (await (
      await request.post("/v1/auth/login", { data: { step: "start", method: "passkey", email } })
    ).json()) as { options: unknown };
    const assertion = await page.evaluate(async (opts) => {
      const { PublicKeyCredential } = window as unknown as {
        PublicKeyCredential: {
          parseRequestOptionsFromJSON(o: unknown): PublicKeyCredentialRequestOptions;
        };
      };
      const cred = (await navigator.credentials.get({
        publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(opts),
      })) as PublicKeyCredential & { toJSON(): unknown };
      return cred.toJSON();
    }, start.options);
    const login = await request.post("/v1/auth/login", {
      data: { step: "finish", method: "passkey", email, credential: assertion, client: "desktop" },
    });
    expect(login.status(), await login.text()).toBe(200);
    const { token, session } = (await login.json()) as {
      token: string;
      session: { assurance: string };
    };
    expect(session.assurance).toBe("passkey");

    const me = (await (
      await request.get("/v1/auth/me", { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { memberships: { venue_id: string; role: string }[] };
    expect(me.memberships[0]?.role).toBe("manager");
    const admin = await request.get(`/v1/venues/${me.memberships[0]!.venue_id}/devices`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(admin.status(), await admin.text()).toBe(200);
  } finally {
    await db.end();
  }
});
