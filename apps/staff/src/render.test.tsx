import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { catalogs, type Locale } from "@west4/shared";
import type { Me, Membership } from "./api.js";
import { Providers, StaffRoutes } from "./App.js";
import type { SessionState } from "./session.js";

/**
 * Every visible string on every shell screen comes from the catalog of the
 * signed-in person's language: the screens are rendered to HTML in Spanish and
 * each text node must match a Spanish catalog entry (or be data: a name, a
 * time, a number). An English word slipping through fails here, before
 * Playwright ever opens a browser.
 */
const andy = (locale: Locale): Membership => ({
  venue_id: "v1",
  membership_id: "m1",
  role: "manager",
  locale,
  venue: {
    id: "v1",
    name: "West 4 Boho Karaoke",
    time_zone: "America/New_York",
    day_cutover: "06:00",
  },
  modules: { rooms: "on", bar_tabs: "on", bar_mode: "off" },
  permissions: ["pos.use", "admin.access", "reports.view", "night.close"],
});

const me = (locale: Locale): Me => ({
  user: { id: "u1", name: "Andy C.", email: "andy@example.com" },
  session: { id: "s1", assurance: "passkey", expires_at: "2026-09-26T10:41:00Z" },
  memberships: [andy(locale)],
  server_time: "2026-09-26T02:41:00Z",
});

const data = new Set(["West 4 Boho Karaoke", "Andy C.", "English", "Español", "☰"]);

function render(path: string, session: SessionState): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Providers session={session}>
        <StaffRoutes />
      </Providers>
    </MemoryRouter>,
  );
}

function textsOf(html: string): string[] {
  return html
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((s) =>
      s
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .trim(),
    )
    .filter((s) => s !== "");
}

function matchers(locale: Locale): RegExp[] {
  return Object.values(catalogs[locale]).map(
    (value) =>
      new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{\w+\\\}/g, ".+")}$`),
  );
}

const screens = [
  "/sign-in",
  "/invite/abc",
  "/tonight",
  "/bar",
  "/runs",
  "/setup",
  "/admin",
  "/admin/team",
  "/nowhere",
];

describe("every shell screen renders from the catalog", () => {
  for (const locale of ["es", "en"] as const) {
    const allowed = matchers(locale);
    const other = matchers(locale === "es" ? "en" : "es").filter(
      (m) => !allowed.some((a) => a.source === m.source),
    );
    it(`in ${locale}, every text on every screen is a ${locale} catalog string or data`, () => {
      const signedIn: SessionState = {
        status: "signedIn",
        me: me(locale),
        membership: andy(locale),
      };
      for (const path of screens) {
        const html = render(path, signedIn);
        for (const text of textsOf(html)) {
          if (data.has(text)) continue;
          expect(
            allowed.some((m) => m.test(text)),
            `${path} (${locale}): "${text}"`,
          ).toBe(true);
          expect(
            other.some((m) => m.test(text)),
            `${path} (${locale}) has the other language: "${text}"`,
          ).toBe(false);
        }
      }
    });
  }

  it("shows a manager Tonight, Bar POS and Lock, and sends a bartender to the bar", () => {
    const html = render("/tonight", { status: "signedIn", me: me("en"), membership: andy("en") });
    expect(textsOf(html)).toEqual(expect.arrayContaining(["Tonight", "Bar POS", "Admin", "Lock"]));
    const bartender = {
      ...andy("es"),
      role: "bartender" as const,
      permissions: ["pos.use" as const],
    };
    const es = render("/bar", {
      status: "signedIn",
      me: { ...me("es"), memberships: [bartender] },
      membership: bartender,
    });
    expect(textsOf(es)).toEqual(
      expect.arrayContaining(["POS del bar", "Bloquear", "Andy C. · Bartender"]),
    );
  });

  it("renders the loading, unreachable and signed-out states from the catalog", () => {
    expect(textsOf(render("/tonight", { status: "loading" }))).toEqual(["Loading…"]);
    expect(textsOf(render("/tonight", { status: "error", message: "x" }))).toEqual([
      "We can't reach the server",
      "Try again",
    ]);
    // Sign-in finds out what the screen is first (a paired computer, a phone, a browser), so it starts loading.
    expect(textsOf(render("/sign-in", { status: "signedOut", reason: "locked" }))).toEqual([
      "Loading…",
    ]);
  });
});
