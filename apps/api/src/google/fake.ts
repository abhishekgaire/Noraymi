import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for Google's OAuth and Business Profile APIs (M5-15), speaking
 * the same HTTP for the calls GoogleClient makes: authorize (redirects back
 * with a code), token (code and refresh grants), accounts, locations, and a
 * PATCH of a location's hours. Tests read what each location holds, and
 * `failNext` makes the next PATCHes answer 503. Local runs and tests only.
 */
export interface FakeLocation {
  title: string;
  regularHours?: unknown;
  specialHours?: unknown;
}

export class FakeGoogle {
  readonly locations = new Map<string, FakeLocation>([
    ["locations/fake-west4", { title: "West 4 Boho Karaoke (test location)" }],
  ]);
  readonly patches: { location: string; body: unknown }[] = [];
  failNext = 0;
  private readonly codes = new Set<string>();
  private readonly refresh = new Set<string>();
  private readonly access = new Set<string>();
  private server: Server | null = null;

  async start(port = 0, host = "127.0.0.1"): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    const a = this.server.address() as AddressInfo;
    return `http://${host}:${a.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  /** A code as Google's consent screen hands back, for tests that skip the redirect. */
  issueCode(): string {
    const code = `fake-code-${randomUUID()}`;
    this.codes.add(code);
    return code;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");

    if (req.method === "GET" && url.pathname === "/fake/health") return send(200, { ok: true });
    if (req.method === "GET" && url.pathname === "/o/oauth2/v2/auth") {
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", this.issueCode());
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(raw);
      if (form.get("grant_type") === "authorization_code") {
        const code = form.get("code") ?? "";
        if (!this.codes.delete(code)) return send(400, { error: "invalid_grant" });
        const refresh = `fake-refresh-${randomUUID()}`;
        this.refresh.add(refresh);
        return send(200, {
          refresh_token: refresh,
          access_token: this.newAccess(),
          expires_in: 3599,
        });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (!this.refresh.has(form.get("refresh_token") ?? ""))
          return send(400, { error: "invalid_grant" });
        return send(200, { access_token: this.newAccess(), expires_in: 3599 });
      }
      return send(400, { error: "unsupported_grant_type" });
    }
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!this.access.has(bearer)) return send(401, { error: { message: "UNAUTHENTICATED" } });
    if (req.method === "GET" && url.pathname === "/v1/accounts")
      return send(200, { accounts: [{ name: "accounts/fake-1", accountName: "Fake account" }] });
    if (req.method === "GET" && url.pathname === "/v1/accounts/fake-1/locations")
      return send(200, {
        locations: [...this.locations].map(([name, l]) => ({ name, title: l.title })),
      });
    const m = /^\/v1\/(locations\/[\w-]+)$/.exec(url.pathname);
    if (req.method === "PATCH" && m) {
      const loc = this.locations.get(m[1]!);
      if (!loc) return send(404, { error: { message: "location not found" } });
      if (this.failNext > 0) {
        this.failNext -= 1;
        return send(503, { error: { message: "backend unavailable" } });
      }
      const body = JSON.parse(raw) as FakeLocation;
      const mask = (url.searchParams.get("updateMask") ?? "").split(",");
      if (mask.includes("regularHours")) loc.regularHours = body.regularHours;
      if (mask.includes("specialHours")) loc.specialHours = body.specialHours;
      this.patches.push({ location: m[1]!, body });
      return send(200, { name: m[1], ...loc });
    }
    return send(404, { error: { message: "not found" } });
  }

  private newAccess(): string {
    const t = `fake-access-${randomUUID()}`;
    this.access.add(t);
    return t;
  }
}
