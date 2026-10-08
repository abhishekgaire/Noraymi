import { describe, expect, it } from "vitest";
import { catalogs } from "@west4/shared";
import { TASKS, matcher, measure, summarize, trialReport, type TrialEventRow } from "./trial.js";

const t0 = Date.parse("2026-10-20T22:00:00Z");
let clock = t0;
const tap = (label: string | null, afterMs: number, who = "Bartender A"): TrialEventRow => {
  clock += afterMs;
  return { who, kind: "tap", label, at: new Date(clock) };
};
const mark = (kind: TrialEventRow["kind"], afterMs: number, label: string | null = null) => {
  clock += afterMs;
  return { who: "Bartender A", kind, label, at: new Date(clock) } as TrialEventRow;
};

describe("the timed staff trial's report (M9-11)", () => {
  it("every rule names buttons that exist in English and Spanish", () => {
    for (const r of TASKS)
      for (const k of [...(r.start ?? []), ...(r.end === "next" ? [] : r.end)]) {
        expect(catalogs.en[k], k).toBeTruthy();
        expect(catalogs.es[k], k).toBeTruthy();
      }
  });

  it("matches a button's words with its placeholders filled, in either language", () => {
    const m = matcher(["cash.take"]);
    expect(m("Take $7.00 in cash")).toBe(true);
    expect(m(catalogs.es["cash.take"].replace("{amount}", "$7.00"))).toBe(true);
    expect(m("Take cash")).toBe(false);
    expect(m(null)).toBe(false);
  });

  it("measures each task from its start (or its burst) to its end, with taps and errors", () => {
    clock = t0;
    const events = [
      // A walk-up beer: the beer, Pay, Exact — 4.5 s, after an idle gap.
      tap("Heineken", 0),
      tap("Pay", 2_000),
      tap("Exact $9.00", 2_500),
      // Idle, then a tab: New tab … Open, with one error shown.
      tap(catalogs.en["newTab.button"], 30_000),
      tap(catalogs.en["newTab.read"], 3_000),
      mark("error", 1_000, "invalid_request"),
      tap(catalogs.en["newTab.label.standing"], 2_000),
      tap(catalogs.en["newTab.open"], 4_000),
      // Another round: Repeat round, then the next tap.
      tap(catalogs.en["rail.repeat"], 20_000),
      tap("Send", 1_500),
      // A take-over by badge.
      mark("badge", 10_000),
      mark("signed_in", 1_200),
      // A void: the line, Not made, a reason, VOID.
      tap("Margarita", 20_000),
      tap(catalogs.en["fix.made.no"], 1_000),
      tap(catalogs.en["fix.reason.rang"], 1_000),
      tap(catalogs.en["fix.void"], 1_000),
    ];
    const s = measure(events);
    expect(s.map((x) => [x.task, x.seconds, x.taps, x.errors])).toEqual([
      ["walkup_cash", 4.5, 3, 0],
      ["open_tab", 10, 4, 1],
      ["another_round", 1.5, 2, 0],
      ["takeover", 1.2, 0, 0],
      ["void", 3, 4, 0],
    ]);
  });

  it("meets a target only when every run is under it, and times every room order", () => {
    clock = t0;
    const samples = measure([
      tap(catalogs.en["rail.repeat"], 0),
      tap("Send", 2_000),
      tap(catalogs.en["rail.repeat"], 30_000),
      tap("Send", 4_000),
    ]);
    const placed = new Date(t0);
    const rows = summarize(samples, [
      { placedAt: placed, acceptedAt: new Date(t0 + 45_000) },
      { placedAt: placed, acceptedAt: new Date(t0 + 119_000) },
    ]);
    expect(rows.find((r) => r.id === "another_round")).toMatchObject({
      n: 2,
      median: 3,
      worst: 4,
      met: "no",
    });
    expect(rows.find((r) => r.id === "accept_room_order")).toMatchObject({ n: 2, met: "yes" });
    expect(rows.find((r) => r.id === "walkup_cash")!.met).toBe("not run");
    expect(rows.find((r) => r.id === "check_in")!.target).toBe("baseline");
    const late = summarize([], [{ placedAt: placed, acceptedAt: null }]);
    expect(late.find((r) => r.id === "accept_room_order")!.met).toBe("no");
    const md = trialReport("dry run", rows, samples, 0);
    expect(md).toContain("| Another round on a tab | under 3 s | 2 | 3 | 4 | 2 | 0 | no |");
  });
});
