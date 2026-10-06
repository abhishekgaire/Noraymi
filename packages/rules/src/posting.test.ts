import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { latePosting, openBusinessDate, postingBusinessDate } from "./posting.js";

const NY = "America/New_York";
const at = (iso: string, closed: string[] = []) =>
  postingBusinessDate(iso, NY, "06:00", closed).toString();

const here = path.dirname(fileURLToPath(import.meta.url));
const moneyCases = JSON.parse(
  readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8"),
) as {
  cases: {
    id: string;
    group: string;
    inputs: { local_time: string; cutover: string; time_zone: string };
    expected: { business_date: string };
  }[];
};

describe("postingBusinessDate · the seed's business_date group, nothing closed", () => {
  for (const c of moneyCases.cases.filter((x) => x.group === "business_date"))
    it(c.id, () =>
      expect(
        postingBusinessDate(
          c.inputs.local_time,
          c.inputs.time_zone,
          c.inputs.cutover,
          [],
        ).toString(),
      ).toBe(c.expected.business_date),
    );
});

describe("postingBusinessDate · across the 6:00 AM cutover", () => {
  it("5:59 AM Saturday is Friday's while Friday is open", () =>
    expect(at("2026-09-26T05:59:00-04:00")).toBe("2026-09-25"));
  it("Saturday 4:12 AM, before the close: still Friday", () =>
    expect(at("2026-09-26T04:12:00-04:00")).toBe("2026-09-25"));
  it("5:10 AM after Friday closed at 4:48 AM: Saturday", () =>
    expect(at("2026-09-26T05:10:00-04:00", ["2026-09-25"])).toBe("2026-09-26"));
  it("6:00 AM Saturday is Saturday either way", () => {
    expect(at("2026-09-26T06:00:00-04:00")).toBe("2026-09-26");
    expect(at("2026-09-26T06:00:00-04:00", ["2026-09-25"])).toBe("2026-09-26");
  });
});

describe("postingBusinessDate · zero, one and two closed nights in a row", () => {
  const friday = "2026-09-25T23:00:00-04:00";
  it("zero closed: its own night", () => expect(at(friday)).toBe("2026-09-25"));
  it("one closed: the next night", () => expect(at(friday, ["2026-09-25"])).toBe("2026-09-26"));
  it("two closed in a row: past both", () =>
    expect(at(friday, ["2026-09-25", "2026-09-26"])).toBe("2026-09-27"));
  it("a closed night after it changes nothing", () =>
    expect(at(friday, ["2026-09-26"])).toBe("2026-09-25"));
});

describe("postingBusinessDate · the daylight-saving nights", () => {
  it("fall back: 5:30 AM EST on Sun Nov 1, Saturday closed, posts to Sunday", () => {
    expect(at("2026-11-01T05:30:00-05:00")).toBe("2026-10-31");
    expect(at("2026-11-01T05:30:00-05:00", ["2026-10-31"])).toBe("2026-11-01");
  });
  it("fall back: both 1:30 AMs are Saturday's", () => {
    expect(at("2026-11-01T01:30:00-04:00")).toBe("2026-10-31");
    expect(at("2026-11-01T01:30:00-05:00")).toBe("2026-10-31");
  });
  it("spring forward: 5:30 AM EDT on Sun Mar 14, 2027, Saturday closed, posts to Sunday", () => {
    expect(at("2027-03-14T05:30:00-04:00")).toBe("2027-03-13");
    expect(at("2027-03-14T05:30:00-04:00", ["2027-03-13"])).toBe("2027-03-14");
    expect(at("2027-03-14T05:30:00-04:00", ["2027-03-13", "2027-03-14"])).toBe("2027-03-15");
  });
});

describe("openBusinessDate", () => {
  it("leaves an open date alone and steps over closed ones", () => {
    expect(openBusinessDate("2026-09-25", []).toString()).toBe("2026-09-25");
    expect(openBusinessDate("2026-09-30", ["2026-09-30"]).toString()).toBe("2026-10-01");
  });
});

describe("latePosting · a row that belongs to an earlier night (Money rules 16)", () => {
  it("posts to its own night while that's where money posts", () =>
    expect(latePosting("2026-09-25", "2026-09-25")).toEqual({
      businessDate: "2026-09-25",
      adjustsBusinessDate: null,
    }));
  it("after Friday closes, before the cutover: Saturday, adjusting Friday", () =>
    expect(latePosting("2026-09-25", at("2026-09-26T05:10:00-04:00", ["2026-09-25"]))).toEqual({
      businessDate: "2026-09-26",
      adjustsBusinessDate: "2026-09-25",
    }));
  it("days later: that day, adjusting its night", () =>
    expect(latePosting("2026-09-25", "2026-09-28")).toEqual({
      businessDate: "2026-09-28",
      adjustsBusinessDate: "2026-09-25",
    }));
});
