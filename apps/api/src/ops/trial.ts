import { catalogs, type MessageKey } from "@west4/shared";
import type { Queryable } from "@west4/db";

/**
 * The timed staff trial's report (M9-11; spec 10 · How we'll know it works; spec 13 · Tests,
 * Timed staff trial). It reads the practice capture (trial_events) and the rush's room orders
 * for a time window and measures taps, errors and seconds per task against the targets.
 *
 * A task is found by the words on the buttons, in English or Spanish, from the string catalog:
 * it ends on its end button and starts on its start button, or, when its first tap is a menu
 * item (a walk-up beer, a void's line), at the first tap of the burst before the end (taps less
 * than IDLE_MS apart). The staging dry run checks each rule against real taps; the report lists
 * every measured window's taps so a wrong rule shows.
 */
export interface TaskRule {
  readonly id: string;
  readonly task: string;
  /** Under this many seconds; null is a baseline with no target (the front desk). */
  readonly targetS: number | null;
  readonly start?: readonly MessageKey[];
  /** The end button, or "next": the tap after the start. */
  readonly end: readonly MessageKey[] | "next";
}

export const IDLE_MS = 5_000;
const START_WITHIN_MS = 120_000;

export const TASKS: readonly TaskRule[] = [
  {
    id: "walkup_cash",
    task: "A walk-up beer, paid in cash",
    targetS: 8,
    end: ["cash.exact", "cash.handedOver", "cash.take"],
  },
  {
    id: "open_tab",
    task: "Open a tab for a tapped phone, reading the consent line",
    targetS: 20,
    start: ["newTab.button"],
    end: ["newTab.open"],
  },
  {
    id: "another_round",
    task: "Another round on a tab",
    targetS: 3,
    start: ["rail.repeat"],
    end: "next",
  },
  {
    id: "close_tab_tip",
    task: "Close a tab with a tip, with the guest",
    targetS: 20,
    start: ["closeTab.title"],
    end: ["closeTab.done"],
  },
  {
    id: "void",
    task: "Void a drink rung by mistake",
    targetS: 6,
    end: ["fix.void"],
  },
  // The front desk: a baseline only (the ticket's cautious default; the targets table has none).
  {
    id: "check_in",
    task: "Front desk: check in a booking",
    targetS: null,
    start: ["checkIn.button"],
    end: ["checkIn.confirm"],
  },
  {
    id: "walk_in",
    task: "Front desk: seat a walk-in",
    targetS: null,
    start: ["checkIn.button"],
    end: ["checkIn.confirmWalkIn"],
  },
  {
    id: "close_out",
    task: "Front desk: close out a room",
    targetS: null,
    end: ["closeOut.print", "closeOut.text", "closeOut.none"],
  },
];

/** "Take {amount} in cash" → /^Take .+ in cash$/, for English and Spanish. */
const pattern = (text: string) =>
  new RegExp(
    `^${text
      .split(/\{[a-zA-Z]+\}/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".+")}$`,
    "i",
  );

export function matcher(keys: readonly MessageKey[]): (label: string | null) => boolean {
  const res = keys.flatMap((k) => [pattern(catalogs.en[k]), pattern(catalogs.es[k])]);
  return (label) => label !== null && res.some((r) => r.test(label.trim()));
}

export interface TrialEventRow {
  readonly who: string;
  readonly kind: "tap" | "error" | "badge" | "signed_in";
  readonly label: string | null;
  readonly at: Date;
}

export interface Sample {
  readonly task: string;
  readonly who: string;
  readonly seconds: number;
  readonly taps: number;
  readonly errors: number;
  readonly labels: readonly string[];
}

/** Every measured task in one person's (or one screen's) events, in time order. */
export function measure(events: readonly TrialEventRow[]): Sample[] {
  const ev = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const out: Sample[] = [];
  const rules = TASKS.map((r) => ({
    rule: r,
    start: r.start ? matcher(r.start) : null,
    end: r.end === "next" ? null : matcher(r.end),
  }));
  let floor = 0; // nothing before this index belongs to the next task
  const sample = (task: string, from: number, to: number) => {
    const window = ev.slice(from, to + 1);
    out.push({
      task,
      who: ev[to]!.who,
      seconds: (ev[to]!.at.getTime() - ev[from]!.at.getTime()) / 1000,
      taps: window.filter((e) => e.kind === "tap").length,
      errors: window.filter((e) => e.kind === "error").length,
      labels: window.filter((e) => e.kind === "tap").map((e) => e.label ?? "?"),
    });
    floor = to + 1;
  };
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i]!;
    if (i < floor) continue;
    // A take-over: the badge read, then the screen signed in as its person.
    if (e.kind === "badge") {
      const j = ev.findIndex((x, k) => k > i && x.kind === "signed_in");
      if (j > 0 && ev[j]!.at.getTime() - e.at.getTime() <= 30_000) sample("takeover", i, j);
      continue;
    }
    if (e.kind !== "tap") continue;
    for (const { rule, start, end } of rules) {
      if (rule.end === "next") {
        if (start?.(e.label)) {
          const j = ev.findIndex((x, k) => k > i && x.kind === "tap");
          if (j > 0) sample(rule.id, i, j);
        }
        continue;
      }
      if (!end?.(e.label)) continue;
      let from = -1;
      if (start) {
        for (let k = i - 1; k >= floor; k--) {
          if (e.at.getTime() - ev[k]!.at.getTime() > START_WITHIN_MS) break;
          if (ev[k]!.kind === "tap" && start(ev[k]!.label)) {
            from = k;
            break;
          }
        }
        if (from < 0) continue;
      } else {
        from = i;
        while (from - 1 >= floor && ev[from]!.at.getTime() - ev[from - 1]!.at.getTime() < IDLE_MS)
          from--;
      }
      sample(rule.id, from, i);
      break;
    }
  }
  return out;
}

export interface RoomOrderSample {
  readonly placedAt: Date;
  readonly acceptedAt: Date | null;
}

export interface TaskResult {
  readonly id: string;
  readonly task: string;
  readonly target: string;
  readonly n: number;
  readonly median: number | null;
  readonly worst: number | null;
  readonly taps: number | null;
  readonly errors: number;
  readonly met: "yes" | "no" | "baseline" | "not run";
}

const median = (xs: readonly number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The table against the targets. A target is met only when every run of the task is under it. */
export function summarize(
  samples: readonly Sample[],
  orders: readonly RoomOrderSample[],
): TaskResult[] {
  const rows: TaskResult[] = [];
  const all = [
    ...TASKS.slice(0, 5),
    { id: "takeover", task: "Take over the terminal", targetS: 2 },
    ...TASKS.slice(5),
  ];
  for (const r of all) {
    const xs = samples.filter((s) => s.task === r.id);
    const secs = xs.map((s) => s.seconds);
    const worst = secs.length ? Math.max(...secs) : null;
    rows.push({
      id: r.id,
      task: r.task,
      target: r.targetS === null ? "baseline" : `under ${r.targetS} s`,
      n: xs.length,
      median: median(secs),
      worst,
      taps: median(xs.map((s) => s.taps)),
      errors: xs.reduce((a, s) => a + s.errors, 0),
      met:
        xs.length === 0
          ? "not run"
          : r.targetS === null
            ? "baseline"
            : worst! < r.targetS
              ? "yes"
              : "no",
    });
    if (r.id === "another_round") {
      // After the bar's own tasks: the room orders, timed by the server from placed to accepted.
      const waits = orders.map((o) =>
        o.acceptedAt ? (o.acceptedAt.getTime() - o.placedAt.getTime()) / 1000 : Infinity,
      );
      const w = waits.length ? Math.max(...waits) : null;
      rows.push({
        id: "accept_room_order",
        task: "Accept a room order",
        target: "every order within 120 s",
        n: orders.length,
        median: median(waits.filter(Number.isFinite)),
        worst: w === Infinity ? null : w,
        taps: null,
        errors: 0,
        met: orders.length === 0 ? "not run" : w !== null && w <= 120 ? "yes" : "no",
      });
    }
  }
  return rows;
}

const n1 = (x: number | null) => (x === null ? "-" : String(Math.round(x * 10) / 10));

export function trialReport(
  title: string,
  rows: readonly TaskResult[],
  samples: readonly Sample[],
  notAccepted: number,
): string {
  return [
    `# Timed staff trial · ${title}`,
    "",
    "| Task | Target | Runs | Median s | Worst s | Taps (median) | Errors | Met |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.task} | ${r.target} | ${r.n} | ${n1(r.median)} | ${n1(r.worst)} | ${n1(r.taps)} | ${r.errors} | ${r.met} |`,
    ),
    "",
    ...(notAccepted > 0 ? [`${notAccepted} room order(s) never accepted.`, ""] : []),
    "A missed target changes the design (a new ticket), not the target; the trial then runs again.",
    "",
    "## Every measured window",
    "",
    "| Task | Who | Seconds | Taps | Errors |",
    "| --- | --- | --- | --- | --- |",
    ...samples.map(
      (s) => `| ${s.task} | ${s.who} | ${n1(s.seconds)} | ${s.labels.join(" → ")} | ${s.errors} |`,
    ),
    "",
  ].join("\n");
}

/** The window's capture, one stream per person (by name), and the rush's room orders. */
export async function trialEvidence(
  c: Queryable,
  venueId: string,
  from: Date,
  to: Date,
): Promise<{ samples: Sample[]; orders: RoomOrderSample[] }> {
  const events = await c.query<{
    who: string;
    kind: TrialEventRow["kind"];
    label: string | null;
    at: Date;
  }>(
    `select coalesce(u.name, d.name, 'unknown') as who, e.kind, e.label, e.at
       from trial_events e
       left join memberships m on m.venue_id = e.venue_id and m.id = e.membership_id
       left join users u on u.id = m.user_id
       left join devices d on d.venue_id = e.venue_id and d.id = e.device_id
      where e.venue_id = $1 and e.at >= $2 and e.at < $3
      order by e.at`,
    [venueId, from, to],
  );
  const byWho = new Map<string, TrialEventRow[]>();
  for (const e of events.rows) byWho.set(e.who, [...(byWho.get(e.who) ?? []), e]);
  const samples = [...byWho.values()].flatMap(measure);
  const orders = await c.query<{ placed_at: Date; accepted_at: Date | null }>(
    `select o.placed_at, o.accepted_at
       from orders o join checks k on k.venue_id = o.venue_id and k.id = o.check_id
      where o.venue_id = $1 and k.training and o.client_order_id like 'rush-%'
        and o.placed_at >= $2 and o.placed_at < $3
      order by o.placed_at`,
    [venueId, from, to],
  );
  return {
    samples,
    orders: orders.rows.map((o) => ({ placedAt: o.placed_at, acceptedAt: o.accepted_at })),
  };
}
