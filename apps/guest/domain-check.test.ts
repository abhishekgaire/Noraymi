import { describe, expect, it } from "vitest";
import { certDaysLeft, mailChanges, urlProblems } from "./domain-check";

const mail = {
  mx: ["10 mx1.example.net", "20 mx2.example.net"],
  spf: ["v=spf1 include:_spf.example.net ~all"],
  dmarc: ["v=DMARC1; p=none"],
  dkim: { s1: ["v=DKIM1; k=rsa; p=AAA"] },
};

describe("the domain move's checks (M9-09)", () => {
  it("email records kept in any order pass", () => {
    expect(mailChanges(mail, { ...mail, mx: [...mail.mx].reverse() })).toEqual([]);
  });

  it("a lost MX, SPF, DMARC or DKIM record is named", () => {
    const after = { mx: [], spf: [], dmarc: ["v=DMARC1; p=none"], dkim: {} };
    const out = mailChanges(mail, after);
    expect(out).toHaveLength(3);
    expect(out.join(" ")).toMatch(/MX changed.*none/);
    expect(out.join(" ")).toMatch(/DKIM s1/);
  });

  it("an old URL that ends on a 404 fails, a redirect to a page passes", () => {
    expect(
      urlProblems([
        { url: "/reservation", first: 301, final: 200 },
        { url: "/old", first: 404, final: 404 },
      ]),
    ).toEqual(["/old answered 404"]);
  });

  it("counts the certificate's days left", () => {
    expect(certDaysLeft("2026-10-22T00:00:00Z", new Date("2026-10-08T00:00:00Z"))).toBe(14);
  });
});
