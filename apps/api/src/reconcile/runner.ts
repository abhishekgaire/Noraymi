/**
 * The night runner (M7-19): plays a business date to its close through the
 * API only, then the reconcile script checks it to the cent. A `NightClient`
 * makes each call as a person on a device: in CI's one-night compressed mode
 * it's the app's own `inject`; on staging, an HTTP client with each person's
 * session and the connected sandbox with simulated readers (M7-19's 14 real
 * nights, run once staging is up).
 *
 * The compressed night starts from the demo seed's Friday at 10:41 PM and
 * plays what's left of it: ringing orders declined, Diego's waiting void
 * decided on Andy's phone, every room presented, paid and ended, every bar tab
 * paid at the bar, the waitlist cleared, rooms cleaned, unsent drinks cleared,
 * a no-sale and a $5.00 short count at the front desk, cash tips declared and
 * everyone clocked out, the clear-out check at 4:31 AM and the close at 4:48.
 */
export interface Actor {
  readonly who: string;
  readonly role: "owner" | "manager" | "bartender" | "front_desk";
  readonly session: "passkey" | "pin" | "badge";
  readonly device: string;
}

export interface NightClient {
  call(
    as: Actor,
    method: "GET" | "POST" | "PUT" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }>;
  /** Moves the simulated clock (staging's `/v1/ops/clock`; the test's frozen clock). */
  setClock(iso: string): Promise<void>;
}

export const ANDY_PHONE: Actor = {
  who: "andy",
  role: "manager",
  session: "passkey",
  device: "dev_phone_andy",
};
export const DIEGO_DESK: Actor = {
  who: "diego",
  role: "front_desk",
  session: "pin",
  device: "dev_front_computer",
};
export const MAYA_BAR: Actor = {
  who: "maya",
  role: "bartender",
  session: "pin",
  device: "dev_bar_computer",
};
const PINS: Record<string, string> = { maya: "4071", diego: "6358", andy: "730915" };

export interface RunStep {
  readonly step: string;
  readonly status: number;
}

/** Plays the night; every call that fails stops the run, naming the step. */
export async function playNight(client: NightClient, date: string): Promise<RunStep[]> {
  const steps: RunStep[] = [];
  const must = async (
    step: string,
    as: Actor,
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ) => {
    const r = await client.call(as, method, path, body);
    steps.push({ step, status: r.status });
    if (r.status >= 300)
      throw new Error(`${step}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
    return r.json;
  };

  // Ringing and asked-to-wait orders: the bar declines them as the night winds down.
  const orders = (await must("list orders", MAYA_BAR, "GET", "/orders")) as {
    orders: { id: string; status: string }[];
  };
  for (const o of orders.orders.filter((x) => x.status === "ringing" || x.status === "held"))
    await must(`decline order ${o.id}`, MAYA_BAR, "POST", `/orders/${o.id}/decline`, {
      reason: "Closing up",
    });

  // Diego's void, waiting for Andy: decided on Andy's own phone.
  const approvals = (await must("approvals", ANDY_PHONE, "GET", "/approvals")) as {
    waiting_for_me: { id: string }[];
  };
  for (const a of approvals.waiting_for_me)
    await must(`decide ${a.id}`, ANDY_PHONE, "POST", `/approvals/${a.id}/decide`, {
      decision: "approve",
    });

  // Unsent drinks are cleared first, so every check can be presented.
  const tabs = (await must("tabs", MAYA_BAR, "GET", "/tabs")) as {
    tabs: { id: string; check_id: string; state: string; owner_id: string | null }[];
  };
  for (const t of tabs.tabs.filter((x) => x.state === "open")) {
    for (const as of [MAYA_BAR, DIEGO_DESK]) {
      const d = (await must(`draft ${t.id}`, as, "GET", `/drafts/${t.check_id}`)) as {
        lines: unknown[];
        version: number;
      };
      if (d.lines.length > 0)
        await must(`clear draft ${t.id}`, as, "PUT", `/drafts/${t.check_id}`, {
          lines: [],
          version: d.version,
        });
    }
  }

  // Every bar tab paid in cash at the bar, at what it owes, through the tab's own Pay, which finalizes
  // the check first (its tax, Money rules 8). The open check's amount due is before tax, so the first
  // ask is answered with the tab's balance and asked again at it (M9-15: paying the open check directly
  // left five tabs paid without tax, which the money audit caught).
  for (const t of tabs.tabs.filter((x) => x.state === "open")) {
    const check = (await must(`check ${t.check_id}`, MAYA_BAR, "GET", `/checks/${t.check_id}`)) as {
      amount_due_cents: number;
    };
    if (check.amount_due_cents <= 0) continue;
    const pay = (cents: number) =>
      client.call(MAYA_BAR, "POST", `/tabs/${t.id}/pay`, {
        method: "cash",
        amount_cents: cents,
        tendered_cents: cents,
      });
    let r = await pay(check.amount_due_cents);
    const details = (r.json["error"] as { details?: { amount_cents?: number } } | undefined)
      ?.details;
    if (r.status === 400 && details?.amount_cents) r = await pay(details.amount_cents);
    steps.push({ step: `pay tab ${t.id}`, status: r.status });
    if (r.status >= 300) throw new Error(`pay tab ${t.id}: ${r.status} ${JSON.stringify(r.json)}`);
  }

  // Every room: presented, paid in cash at the front desk, ended.
  const board = (await must("board", ANDY_PHONE, "GET", "/board")) as {
    rooms: { session?: { id: string; check_id: string | null } | null }[];
  };
  for (const r of board.rooms) {
    const s = r.session;
    if (!s?.check_id) continue;
    await must(`present ${s.check_id}`, DIEGO_DESK, "POST", `/checks/${s.check_id}/present`);
    const check = (await must(
      `check ${s.check_id}`,
      DIEGO_DESK,
      "GET",
      `/checks/${s.check_id}`,
    )) as {
      amount_due_cents: number;
    };
    if (check.amount_due_cents > 0)
      await must(`pay ${s.check_id}`, DIEGO_DESK, "POST", `/checks/${s.check_id}/payments`, {
        method: "cash",
        amount_cents: check.amount_due_cents,
        tendered_cents: check.amount_due_cents,
      });
    // Paid in full, a room's session usually ends by itself; otherwise the front desk ends it.
    const ended = await client.call(DIEGO_DESK, "POST", `/sessions/${s.id}/end`);
    steps.push({ step: `end ${s.id}`, status: ended.status });
    if (ended.status >= 300 && !JSON.stringify(ended.json).includes("has ended"))
      throw new Error(`end ${s.id}: ${ended.status} ${JSON.stringify(ended.json).slice(0, 300)}`);
  }

  // The waitlist, and rooms waiting to be cleaned.
  const waitlist = (await must("waitlist", DIEGO_DESK, "GET", "/waitlist")) as {
    entries: { id: string; status: string }[];
  };
  for (const w of waitlist.entries.filter((x) => x.status === "waiting" || x.status === "offered"))
    await must(`remove ${w.id}`, DIEGO_DESK, "POST", `/waitlist/${w.id}/remove`, {
      reason: "closing",
    });

  // Late: the clear-out check is due at 4:30 AM.
  await client.setClock(`${addDay(date)}T04:31:00-04:00`);
  const cleaning = (await must("board again", ANDY_PHONE, "GET", "/board")) as {
    rooms: { room_id: string; state: string }[];
  };
  for (const r of cleaning.rooms.filter((x) => x.state === "cleaning"))
    await must(`clean ${r.room_id}`, DIEGO_DESK, "POST", `/rooms/${r.room_id}/clean`, {});

  // The drawers: a no-sale at the front desk, then both counted, the front desk $5.00 short.
  const drawers = (await must("drawers", ANDY_PHONE, "GET", "/drawers")) as {
    drawers: { name: string; sessions: { id: string; state: string }[] }[];
  };
  const front = drawers.drawers
    .find((d) => d.name === "Front-desk drawer")!
    .sessions.find((s) => s.state === "open")!;
  await must("no-sale", DIEGO_DESK, "POST", `/drawer-sessions/${front.id}/no-sale`, {
    reason: "Change",
    pin: PINS["diego"],
  });
  // What each drawer holds, as the cash in hand would show it: the running X report's drawer figures.
  const x = (await must("x report", ANDY_PHONE, "GET", `/nights/${date}/report`)) as {
    drawers: {
      drawer: string;
      state: string;
      opening_cents: number;
      cash_taken_cents: number;
      drops_cents: number;
      paid_outs_cents: number;
      tip_outs_cents: number;
      refunds_cents: number;
    }[];
  };
  for (const d of drawers.drawers) {
    const open = d.sessions.find((s) => s.state === "open");
    if (!open) continue;
    const held = x.drawers.find((r) => r.drawer === d.name && r.state === "open")!;
    const inHand =
      held.opening_cents +
      held.cash_taken_cents +
      held.drops_cents -
      held.paid_outs_cents -
      held.tip_outs_cents -
      held.refunds_cents;
    // The front desk counts $5.00 short: under the note limit, so no note or second counter.
    const short = d.name === "Front-desk drawer" ? 500 : 0;
    await must(`count ${d.name}`, ANDY_PHONE, "POST", `/drawer-sessions/${open.id}/count`, {
      counted_cents: inHand - short,
    });
  }

  // Everyone clocks out: cash tips declared, then out. The closing manager is clocked out by the close.
  for (const as of [MAYA_BAR, DIEGO_DESK]) {
    await must(`declare ${as.who}`, as, "POST", "/shifts/declare-tips", {
      cash_tips_cents: as.who === "maya" ? 1500 : 0,
    });
    await must(`clock out ${as.who}`, as, "POST", "/shifts/clock-out");
  }

  await must("clear-out", ANDY_PHONE, "POST", `/nights/${date}/clear-out`, {});
  await client.setClock(`${addDay(date)}T04:48:00-04:00`);
  await must("close", ANDY_PHONE, "POST", `/nights/${date}/close`, {});
  return steps;
}

function addDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
