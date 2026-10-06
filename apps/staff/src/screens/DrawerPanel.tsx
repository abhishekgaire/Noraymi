import { useCallback, useEffect, useState } from "react";
import type { Cents } from "@west4/shared";
import { api, ApiCallError } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { uploadPhoto } from "../upload.js";

/**
 * The cash drawers (M7-05; Money rules 15; screens Night note 7, Board note
 * 18): both house drawers, blind until counted, then opened with, cash taken,
 * paid-outs, drops, should be, counted, over or short, the note, who counted
 * and the second counter. Counting sends only the number; what the drawer
 * should hold shows in the answer. The manager on duty hands both drawers to
 * the next manager with a blind count each, and the screen shows "Waiting for
 * Abhishek" until he accepts on his own phone.
 *
 * At the drawer's own screen (M7-06): Drop my cash hands the person's staff
 * bank in, Paid-out takes cash out with a reason and the receipt's photo (over
 * the limit it waits for an approval), No sale opens the drawer with a reason,
 * and a manager's Tip-out pays a named person. Each shows in the drawer's log,
 * which leaves sales out so the panel stays blind.
 */
interface Count {
  readonly counted_cents: number;
  readonly expected_cents: number;
  readonly over_short_cents: number;
  readonly note: string | null;
  readonly counted_by: string | null;
  readonly witness: string | null;
}
interface Session {
  readonly id: string;
  readonly state: "open" | "pulled" | "counted" | "closed";
  readonly opened_with_cents: number;
  readonly responsible: string | null;
  readonly waiting_for: string | null;
  readonly count: Count | null;
  readonly cash_taken_cents?: number;
  readonly paid_outs_cents?: number;
  readonly drops_cents?: number;
  readonly refunds_cents?: number;
  readonly tip_outs_cents?: number;
  readonly moves: readonly Move[];
}
interface Move {
  readonly id: string;
  readonly kind: "refund" | "paid_out" | "drop" | "no_sale" | "tip_out";
  readonly amount_cents: number;
  readonly by: string;
  readonly paid_to: string | null;
  readonly reason: string | null;
}
interface Drawer {
  readonly id: string;
  readonly name: string;
  readonly can_count: boolean;
  /** This screen is paired to the drawer: moves happen here. */
  readonly here: boolean;
  readonly sessions: readonly Session[];
}
interface Person {
  readonly user_id: string;
  readonly name: string;
  readonly role: string;
}
interface Drawers {
  readonly drawers: readonly Drawer[];
  readonly people: readonly Person[];
  readonly me: {
    readonly user_id: string | null;
    readonly pin_again: boolean;
    readonly bank_cents: number;
    readonly role: string | null;
  };
  readonly handover: { readonly waiting_for: { readonly name: string } } | null;
}
interface Answer {
  readonly expected_cents: number;
  readonly over_short_cents: number;
}

/** Dollars typed as text to cents, never through a float: "275" and "275.5" and "275.50". */
function toCents(text: string): number | null {
  const m = /^\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export function DrawerPanel({ venueId, canHandOver }: { venueId: string; canHandOver: boolean }) {
  const { t, money } = useT();
  const { subscribe } = useEvents();
  const [data, setData] = useState<Drawers | null>(null);
  const [failed, setFailed] = useState(false);
  // The form open now: one drawer's count or move, or the handover of every open drawer.
  const [form, setForm] = useState<
    | { kind: "count" | "paid_out" | "no_sale" | "tip_out"; drawer: Drawer }
    | { kind: "handover" }
    | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
  const done = (message?: string) => {
    setForm(null);
    setNotice(message ?? null);
    void load();
  };

  const load = useCallback(async () => {
    try {
      setData(await api<Drawers>("GET", `/v1/venues/${venueId}/drawers`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (
          events.length === 0 ||
          events.some((e) => e.type === "drawer.updated" || e.type.startsWith("approval."))
        )
          void load();
      }),
    [subscribe, load],
  );

  if (failed && !data)
    return (
      <p role="alert" className="error">
        {t("drawer.failed")}
      </p>
    );
  if (!data) return <p role="status">{t("shell.loading")}</p>;
  const open = data.drawers.filter((d) => d.sessions.some((s) => s.state === "open"));
  return (
    <section className="drawers" aria-labelledby="drawers-title">
      <div className="room-clock-head">
        <h2 id="drawers-title">{t("drawers.title")}</h2>
        {canHandOver && open.length > 0 && !data.handover && form === null && (
          <button type="button" className="secondary" onClick={() => setForm({ kind: "handover" })}>
            {t("drawer.handover")}
          </button>
        )}
      </div>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {data.handover && (
        <p role="status" className="notice">
          {t("drawer.waitingFor", { name: data.handover.waiting_for.name })}
        </p>
      )}
      {form?.kind === "handover" && (
        <Handover
          venueId={venueId}
          data={data}
          drawers={open}
          onDone={() => {
            setForm(null);
            void load();
          }}
        />
      )}
      {data.drawers.length === 0 && <p className="muted">{t("drawer.none")}</p>}
      {data.drawers.map((d) => (
        <article key={d.id} className="drawer-card" aria-label={d.name}>
          <h3>{d.name}</h3>
          {d.sessions.map((s) => (
            <SessionView key={s.id} session={s} money={money} t={t} />
          ))}
          {d.can_count && d.sessions.some((s) => s.state === "open") && form === null && (
            <button type="button" onClick={() => setForm({ kind: "count", drawer: d })}>
              {t("drawer.count")}
            </button>
          )}
          {d.here && form === null && d.sessions.some((s) => s.state === "open") && (
            <MoveButtons
              venueId={venueId}
              data={data}
              drawer={d}
              onOpen={(kind) => setForm({ kind, drawer: d })}
              onDone={done}
            />
          )}
          {form && form.kind !== "handover" && form.kind !== "count" && form.drawer.id === d.id && (
            <MoveForm kind={form.kind} venueId={venueId} data={data} drawer={d} onDone={done} />
          )}
          {form?.kind === "count" && form.drawer.id === d.id && (
            <CountForm
              venueId={venueId}
              data={data}
              drawer={d}
              onDone={() => {
                setForm(null);
                void load();
              }}
            />
          )}
        </article>
      ))}
    </section>
  );
}

type T = ReturnType<typeof useT>["t"];
type Money = ReturnType<typeof useT>["money"];

function overShort(t: T, money: Money, cents: number): string {
  if (cents === 0) return t("drawer.matches");
  return cents > 0
    ? t("drawer.over", { amount: money(cents as Cents) })
    : t("drawer.short", { amount: money(-cents as Cents) });
}

function moveLine(t: T, money: Money, m: Move): string {
  const amount = money(m.amount_cents as Cents);
  const what =
    m.kind === "drop"
      ? t("drawer.move.drop", { amount })
      : m.kind === "paid_out"
        ? t("drawer.move.paid_out", { amount })
        : m.kind === "tip_out"
          ? t("drawer.move.tip_out", { amount })
          : m.kind === "refund"
            ? t("drawer.move.refund", { amount })
            : t("drawer.move.no_sale");
  return [what, m.paid_to ? t("drawer.move.to", { name: m.paid_to }) : null, m.by, m.reason]
    .filter(Boolean)
    .join(" · ");
}

function SessionView({ session: s, t, money }: { session: Session; t: T; money: Money }) {
  const rows: [string, number][] = [[t("drawer.openedWith"), s.opened_with_cents]];
  if (s.count) {
    rows.push(
      [t("drawer.cashTaken"), s.cash_taken_cents ?? 0],
      [t("drawer.paidOuts"), s.paid_outs_cents ?? 0],
      [t("drawer.drops"), s.drops_cents ?? 0],
    );
    if (s.refunds_cents) rows.push([t("drawer.refunds"), s.refunds_cents]);
    if (s.tip_outs_cents) rows.push([t("drawer.tipOuts"), s.tip_outs_cents]);
    rows.push(
      [t("drawer.shouldBe"), s.count.expected_cents],
      [t("drawer.counted"), s.count.counted_cents],
    );
  }
  return (
    <div className="drawer-session">
      <p className="small muted">
        {s.state === "open" ? t("drawer.blind") : s.state === "closed" ? t("drawer.closed") : ""}
        {s.responsible ? ` · ${t("drawer.answersFor", { name: s.responsible })}` : ""}
        {s.waiting_for ? ` · ${t("drawer.waitingFor", { name: s.waiting_for })}` : ""}
      </p>
      <dl className="drawer-figures">
        {rows.map(([label, cents]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{money(cents as Cents)}</dd>
          </div>
        ))}
      </dl>
      {s.count && (
        <>
          <p className={s.count.over_short_cents === 0 ? "" : "warn"}>
            {overShort(t, money, s.count.over_short_cents)}
          </p>
          {s.count.note && <p className="small">{s.count.note}</p>}
          <p className="small muted">
            {s.count.counted_by ? t("drawer.countedBy", { name: s.count.counted_by }) : ""}
            {s.count.witness ? ` · ${t("drawer.witnessed", { name: s.count.witness })}` : ""}
          </p>
        </>
      )}
      {s.moves.length > 0 && (
        <ul className="drawer-log">
          {s.moves.map((m) => (
            <li key={m.id} className="small">
              {moveLine(t, money, m)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** At the drawer's own screen: Drop my cash at once; Paid-out, No sale and Tip-out open their form. */
function MoveButtons({
  venueId,
  data,
  drawer,
  onOpen,
  onDone,
}: {
  venueId: string;
  data: Drawers;
  drawer: Drawer;
  onOpen: (kind: "paid_out" | "no_sale" | "tip_out") => void;
  onDone: (message?: string) => void;
}) {
  const { t, money } = useT();
  const [error, setError] = useState(false);
  const session = drawer.sessions.find((s) => s.state === "open")!;
  const manager = data.me.role === "owner" || data.me.role === "manager";
  const drop = async () => {
    setError(false);
    try {
      const r = await api<{ amount_cents: number; logged_to: { name: string; drawer: string } }>(
        "POST",
        `/v1/venues/${venueId}/drawer-sessions/${session.id}/drop`,
        undefined,
        { idempotencyKey: `drop-${session.id}-${Date.now()}` },
      );
      onDone(
        `${t("drawer.move.drop", { amount: money(r.amount_cents as Cents) })} · ${t("cash.logged", {
          name: r.logged_to.name,
          drawer: r.logged_to.drawer,
        })}`,
      );
    } catch {
      setError(true);
    }
  };
  return (
    <div className="actions">
      {data.me.bank_cents > 0 && (
        <button type="button" onClick={() => void drop()}>
          {t("drawer.dropMine", { amount: money(data.me.bank_cents as Cents) })}
        </button>
      )}
      {drawer.can_count && (
        <>
          <button type="button" className="secondary" onClick={() => onOpen("paid_out")}>
            {t("drawer.paidOut")}
          </button>
          <button type="button" className="secondary" onClick={() => onOpen("no_sale")}>
            {t("drawer.noSale")}
          </button>
        </>
      )}
      {manager && (
        <button type="button" className="secondary" onClick={() => onOpen("tip_out")}>
          {t("drawer.tipOut")}
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {t("drawer.moveFailed")}
        </p>
      )}
    </div>
  );
}

/** A paid-out (amount, reason, the receipt's photo), a no-sale (a reason) or a tip-out (who, how much). */
function MoveForm({
  kind,
  venueId,
  data,
  drawer,
  onDone,
}: {
  kind: "paid_out" | "no_sale" | "tip_out";
  venueId: string;
  data: Drawers;
  drawer: Drawer;
  onDone: (message?: string) => void;
}) {
  const { t } = useT();
  const session = drawer.sessions.find((s) => s.state === "open")!;
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [paidTo, setPaidTo] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = toCents(amount);
  const ready =
    kind === "paid_out"
      ? cents !== null && cents > 0 && reason.trim() !== "" && photo !== null
      : kind === "no_sale"
        ? reason.trim() !== ""
        : cents !== null && cents > 0 && paidTo !== "";
  const pinAsked = data.me.pin_again && kind !== "paid_out";
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const path = `/v1/venues/${venueId}/drawer-sessions/${session.id}/${kind.replace("_", "-")}`;
      const body =
        kind === "paid_out"
          ? {
              amount_cents: cents,
              reason: reason.trim(),
              photo_file_id: await uploadPhoto(venueId, "paid_out_photo", photo!),
            }
          : kind === "no_sale"
            ? { reason: reason.trim(), ...(pinAsked ? { pin } : {}) }
            : { paid_to: paidTo, amount_cents: cents, ...(pinAsked ? { pin } : {}) };
      const r = await api<{ status?: string; waiting_for?: { name: string } }>("POST", path, body, {
        idempotencyKey: `${kind}-${session.id}-${Date.now()}`,
      });
      onDone(
        r.status === "approval_pending" && r.waiting_for
          ? t("drawer.waitingFor", { name: r.waiting_for.name })
          : undefined,
      );
    } catch (e) {
      setError(
        e instanceof ApiCallError && e.status === 401
          ? t("drawer.wrongPin")
          : t("drawer.moveFailed"),
      );
    } finally {
      setBusy(false);
    }
  };
  const title =
    kind === "paid_out"
      ? t("drawer.paidOut")
      : kind === "no_sale"
        ? t("drawer.noSale")
        : t("drawer.tipOut");
  return (
    <form
      className="invite-fields count-form"
      aria-label={title}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h4>{title}</h4>
      {kind === "tip_out" && (
        <label>
          <span>{t("drawer.paidTo")}</span>
          <select
            aria-label={t("drawer.paidTo")}
            value={paidTo}
            onChange={(e) => setPaidTo(e.target.value)}
          >
            <option value="">{t("drawer.pick")}</option>
            {data.people.map((p) => (
              <option key={p.user_id} value={p.user_id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind !== "no_sale" && (
        <label>
          <span>{t("drawer.amountOut")}</span>
          <input
            inputMode="decimal"
            aria-label={t("drawer.amountOut")}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
      )}
      {kind !== "tip_out" && (
        <label>
          <span>{t("drawer.reason")}</span>
          <input
            aria-label={t("drawer.reason")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      )}
      {kind === "paid_out" && (
        <label>
          <span>{t("drawer.receipt")}</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/heic"
            capture="environment"
            aria-label={t("drawer.receipt")}
            onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
          />
        </label>
      )}
      {pinAsked && (
        <label>
          <span>{t("drawer.pin")}</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            aria-label={t("drawer.pin")}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </label>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={busy || !ready}>
          {t("drawer.openIt")}
        </button>
        <button type="button" className="link" onClick={() => onDone()}>
          {t("drawer.cancel")}
        </button>
      </div>
    </form>
  );
}

/** The blind count's fields, and what a refusal asks for next (a note, a second counter). */
function useCountFields() {
  const [amount, setAmount] = useState("");
  const [pin, setPin] = useState("");
  const [note, setNote] = useState("");
  const [witness, setWitness] = useState("");
  const [witnessPin, setWitnessPin] = useState("");
  return {
    amount,
    setAmount,
    pin,
    setPin,
    note,
    setNote,
    witness,
    setWitness,
    witnessPin,
    setWitnessPin,
  };
}
type Fields = ReturnType<typeof useCountFields>;

function body(f: Fields, data: Drawers, needs: { note: boolean; witness: boolean }) {
  return {
    counted_cents: toCents(f.amount),
    ...(data.me.pin_again ? { pin: f.pin } : {}),
    ...(needs.note && f.note.trim() ? { note: f.note.trim() } : {}),
    ...(needs.witness && f.witness ? { witness: { user_id: f.witness, pin: f.witnessPin } } : {}),
  };
}

function errorText(t: T, money: Money, e: unknown): string {
  if (e instanceof ApiCallError) {
    if (e.status === 401) return t("drawer.wrongPin");
    if (e.code === "version_conflict" && typeof e.details["counted_cents"] === "number")
      return t("drawer.alreadyCounted", { amount: money(e.details["counted_cents"] as Cents) });
  }
  return t("drawer.countFailed");
}

function Fields({
  f,
  data,
  needs,
  witnesses,
  amountLabel,
}: {
  f: Fields;
  data: Drawers;
  needs: { note: boolean; witness: boolean };
  witnesses: readonly Person[];
  amountLabel: string;
}) {
  const { t } = useT();
  return (
    <>
      <label>
        <span>{amountLabel}</span>
        <input
          inputMode="decimal"
          aria-label={amountLabel}
          value={f.amount}
          onChange={(e) => f.setAmount(e.target.value)}
        />
      </label>
      {data.me.pin_again && (
        <label>
          <span>{t("drawer.pin")}</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            aria-label={t("drawer.pin")}
            value={f.pin}
            onChange={(e) => f.setPin(e.target.value)}
          />
        </label>
      )}
      {needs.note && (
        <label>
          <span>{t("drawer.note")}</span>
          <input
            aria-label={t("drawer.note")}
            value={f.note}
            onChange={(e) => f.setNote(e.target.value)}
          />
        </label>
      )}
      {needs.witness && (
        <>
          <label>
            <span>{t("drawer.witnessWho")}</span>
            <select
              aria-label={t("drawer.witnessWho")}
              value={f.witness}
              onChange={(e) => f.setWitness(e.target.value)}
            >
              <option value="">{t("drawer.pick")}</option>
              {witnesses.map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("drawer.witnessPin")}</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              aria-label={t("drawer.witnessPin")}
              value={f.witnessPin}
              onChange={(e) => f.setWitnessPin(e.target.value)}
            />
          </label>
        </>
      )}
    </>
  );
}

/** What a refusal asked for: after it, the screen shows what the drawer should hold. */
function readRefusal(e: unknown): { reason: "note" | "witness"; answer: Answer } | null {
  if (!(e instanceof ApiCallError) || e.code !== "invalid_request") return null;
  const reason = e.details["reason"];
  if (reason !== "note" && reason !== "witness") return null;
  return { reason, answer: e.details["answer"] as Answer };
}

function CountForm({
  venueId,
  data,
  drawer,
  onDone,
}: {
  venueId: string;
  data: Drawers;
  drawer: Drawer;
  onDone: () => void;
}) {
  const { t, money } = useT();
  const f = useCountFields();
  const [needs, setNeeds] = useState({ note: false, witness: false });
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = drawer.sessions.find((s) => s.state === "open")!;
  const save = async () => {
    if (toCents(f.amount) === null) return;
    setBusy(true);
    setError(null);
    try {
      await api(
        "POST",
        `/v1/venues/${venueId}/drawer-sessions/${session.id}/count`,
        body(f, data, needs),
        {
          idempotencyKey: `count-${session.id}-${Date.now()}`,
        },
      );
      onDone();
    } catch (e) {
      const refusal = readRefusal(e);
      if (refusal) {
        setAnswer(refusal.answer);
        setNeeds((n) => ({
          note: n.note || refusal.reason === "note",
          witness: n.witness || refusal.reason === "witness",
        }));
      } else setError(errorText(t, money, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="invite-fields count-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="small muted">{t("drawer.countHint")}</p>
      <Fields
        f={f}
        data={data}
        needs={needs}
        witnesses={data.people.filter((p) => p.user_id !== data.me.user_id)}
        amountLabel={t("drawer.amount")}
      />
      {answer && (
        <p role="status">
          {t("drawer.shouldBe")}: {money(answer.expected_cents as Cents)} ·{" "}
          {overShort(t, money, answer.over_short_cents)}
        </p>
      )}
      {needs.note && <p className="small">{t("drawer.noteNeeded")}</p>}
      {needs.witness && <p className="small">{t("drawer.witnessNeeded")}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={busy || toCents(f.amount) === null}>
          {t("drawer.save")}
        </button>
        <button type="button" className="link" onClick={onDone}>
          {t("drawer.cancel")}
        </button>
      </div>
    </form>
  );
}

/** Hand over every open house drawer: one blind count each, to the incoming manager. */
function Handover({
  venueId,
  data,
  drawers,
  onDone,
}: {
  venueId: string;
  data: Drawers;
  drawers: readonly Drawer[];
  onDone: () => void;
}) {
  const { t, money } = useT();
  const [incoming, setIncoming] = useState("");
  const [index, setIndex] = useState(0);
  const f = useCountFields();
  const [needs, setNeeds] = useState({ note: false, witness: false });
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const managers = data.people.filter(
    (p) => (p.role === "owner" || p.role === "manager") && p.user_id !== data.me.user_id,
  );
  const drawer = drawers[index];
  if (!drawer) return null;
  const save = async () => {
    if (!incoming || toCents(f.amount) === null) return;
    setBusy(true);
    setError(null);
    try {
      await api(
        "POST",
        `/v1/venues/${venueId}/drawers/${drawer.id}/handover`,
        { incoming, ...body(f, data, needs) },
        { idempotencyKey: `handover-${drawer.id}-${Date.now()}` },
      );
      // The next drawer, fresh, until every drawer is counted.
      if (index + 1 >= drawers.length) onDone();
      else {
        setIndex(index + 1);
        f.setAmount("");
        f.setNote("");
        f.setWitness("");
        f.setWitnessPin("");
        setNeeds({ note: false, witness: false });
        setAnswer(null);
      }
    } catch (e) {
      const refusal = readRefusal(e);
      if (refusal) {
        setAnswer(refusal.answer);
        setNeeds((n) => ({
          note: n.note || refusal.reason === "note",
          witness: n.witness || refusal.reason === "witness",
        }));
      } else setError(errorText(t, money, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="invite-fields count-form"
      aria-label={t("drawer.handover")}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="small muted">{t("drawer.handoverHint")}</p>
      <label>
        <span>{t("drawer.incoming")}</span>
        <select
          aria-label={t("drawer.incoming")}
          value={incoming}
          disabled={index > 0}
          onChange={(e) => setIncoming(e.target.value)}
        >
          <option value="">{t("drawer.pick")}</option>
          {managers.map((p) => (
            <option key={p.user_id} value={p.user_id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <h3>{drawer.name}</h3>
      <Fields
        f={f}
        data={data}
        needs={needs}
        witnesses={data.people.filter((p) => p.user_id !== data.me.user_id)}
        amountLabel={t("drawer.amount")}
      />
      {answer && (
        <p role="status">
          {t("drawer.shouldBe")}: {money(answer.expected_cents as Cents)} ·{" "}
          {overShort(t, money, answer.over_short_cents)}
        </p>
      )}
      {needs.note && <p className="small">{t("drawer.noteNeeded")}</p>}
      {needs.witness && <p className="small">{t("drawer.witnessNeeded")}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={busy || !incoming || toCents(f.amount) === null}>
          {t("drawer.handOver")}
        </button>
        <button type="button" className="link" onClick={onDone}>
          {t("drawer.cancel")}
        </button>
      </div>
    </form>
  );
}
