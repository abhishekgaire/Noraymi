import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { staffOrderWordsKey, unsentFood } from "@west4/shared";
import { api, type ApiCallError } from "../api.js";
import { serverNowMs, useClock } from "../clock.js";
import { useSession } from "../session.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useCutOffWords } from "./CutOff.js";
import {
  SendToKitchen,
  UnsentReminder,
  UnsentWarning,
  type CheckFood,
  type KitchenLine,
  type KitchenNotes,
} from "./SendToKitchen.js";

/**
 * Adding drinks to a room from DeskRoom and the Room phone (M3-07; spec 10 ·
 * Adding drinks to a room from a staff screen, rules 3 and 8): the bar
 * POS's menu search, a drink rung with its usual options already set,
 * tapping it again for two, an amber line until a choice with no default
 * is made (the send button names it), and 86'd drinks greyed in their place.
 * Unsent drinks are saved on the server as they're rung, so they survive a
 * reload and follow the person to their other screens. Send makes a staff
 * order that's accepted at once: on the tab, and a ticket at the bar.
 */
interface Option {
  readonly id: string;
  readonly name: string;
  readonly price_delta_cents: number;
  readonly is_default: boolean;
  readonly out_tonight: boolean;
}
interface Group {
  readonly id: string;
  readonly name: string;
  readonly required: boolean;
  readonly options: readonly Option[];
}
interface Variant {
  readonly id: string;
  readonly name: string;
  readonly price_cents: number;
  readonly out_tonight: boolean;
}
interface Item {
  readonly id: string;
  readonly name: string;
  readonly alcohol: boolean;
  /** bar or kitchen (K-02): food waits as Not sent until Send to kitchen (K-05). */
  readonly station?: string;
  readonly out_tonight: boolean;
  readonly variants: readonly Variant[];
  readonly groups: readonly Group[];
}
export interface DraftLine {
  readonly variant_id: string;
  readonly qty: number;
  readonly option_ids: readonly string[];
  /** Food (K-05): when it was rung, on the venue's clock, and its note for the kitchen. */
  readonly rung_at?: string | null;
  readonly kitchen_note?: string | null;
  readonly kitchen_note_allergy?: boolean;
}
interface CheckLine {
  readonly id: number;
  readonly kind: string;
  readonly qty: number;
  readonly description: string;
  readonly kitchen?: CheckFood;
}
interface Order {
  readonly id: string;
  readonly status: string;
  readonly cancel_reason: string | null;
  readonly items: readonly {
    readonly qty: number;
    readonly name_snapshot: string;
    readonly options: readonly { readonly name: string }[];
  }[];
}

const OPEN = "ringing,held,accepted,ready,on_the_way,returned";
const sameLine = (a: DraftLine, b: DraftLine) =>
  a.variant_id === b.variant_id &&
  a.option_ids.length === b.option_ids.length &&
  a.option_ids.every((o) => b.option_ids.includes(o));

export function AddDrinks(props: {
  venueId: string;
  checkId: string;
  /** A room's session; a bar tab has none (M6-02). */
  sessionId?: string | null;
  onSent: () => void;
  /** The bar POS (M6-02) rings from its own grid: no search box here. */
  search?: boolean;
  /** Each new request rings one of this variant, as a tap on the bar POS grid; a food item's
   *  choices picked in its pop-up come with it (K-05, D100). */
  ringRequest?: {
    readonly variantId: string;
    readonly n: number;
    readonly optionIds?: readonly string[];
  } | null;
  /** Bumped when the server changed the draft for us (Repeat round, M6-03). */
  refresh?: number;
  /** Quick sale (M6-05): Pay makes the sale from the lines instead of sending them to a check.
   *  With `kitchen`, it's Send to kitchen coming first (K-05): the sale is made and its food sent. */
  onPay?: (lines: readonly DraftLine[], kitchen?: { name: string | null }) => Promise<void>;
  /** The unsent food count (K-05), for the warning before Close or Pay. */
  onUnsentFood?: (count: number) => void;
  /** Bumped to open the Send to kitchen confirmation from outside (the warning before Close). */
  kitchenRequest?: number;
  /** A bar tab (M6-24): Send the singer a drink sends the round as a gift to a singer in the queue. */
  gift?: { readonly tabId: string; readonly timeZone: string } | undefined;
}) {
  const { t, money, time } = useT();
  const { subscribe } = useEvents();
  const { venueId, checkId } = props;
  const [items, setItems] = useState<readonly Item[] | null>(null);
  // Alcohol refused for this room right now (M3-20): greyed, with the reason in words.
  const [alcoholBlock, setAlcoholBlock] = useState<"window_closed" | "cut_off" | null>(null);
  const [lines, setLines] = useState<readonly DraftLine[]>([]);
  const [orders, setOrders] = useState<readonly Order[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  // A tab's hold (M6-07): a round waiting for a manager, or a raise being checked with Stripe.
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // Kitchen & food (K-05): the reminder's minutes (null while the module is off), the check's food,
  // and the warning before a quick sale is paid with food not sent.
  const [warnMin, setWarnMin] = useState<number | null>(null);
  const [checkLines, setCheckLines] = useState<readonly CheckLine[]>([]);
  const [warnPay, setWarnPay] = useState(false);
  const [kitchenOpen, setKitchenOpen] = useState(0);
  const [kitchenDone, setKitchenDone] = useState<string | null>(null);
  const { now } = useClock();
  const { state: session } = useSession();
  const venueTimeZone =
    session.status === "signedIn" ? session.membership.venue.time_zone : "America/New_York";
  // Send the singer a drink (M6-24): the singers in tonight's queue, and the one this round is for.
  const [singers, setSingers] = useState<readonly { id: string; display_name: string }[]>([]);
  const [giftFor, setGiftFor] = useState("");
  const cutOffWords = useCutOffWords(props.gift?.timeZone ?? "America/New_York");
  const giftTabId = props.gift?.tabId;
  useEffect(() => {
    if (!giftTabId) return;
    let live = true;
    // Bar mode off, or the queue unreachable: no singers to send to, and the picker stays hidden.
    api<{ singers: { id: string; display_name: string }[] }>(
      "GET",
      `/v1/venues/${venueId}/song-queue`,
    ).then(
      (q) => live && setSingers(q.singers ?? []),
      () => live && setSingers([]),
    );
    return () => {
      live = false;
    };
  }, [venueId, giftTabId]);
  const giftName = singers.find((x) => x.id === giftFor)?.display_name ?? null;
  const version = useRef(0);
  // Undo, step by step, on unsent drinks (M6-03): each change keeps what was there before.
  const history = useRef<(readonly DraftLine[])[]>([]);

  const loadMenu = useCallback(async () => {
    const tree = await api<{
      categories: { items: Item[] }[];
      alcohol: { state: string; closes_at: string; blocked: "window_closed" | "cut_off" | null };
    }>(
      "GET",
      // A room asks for its session; a bar tab for its check, so its cut-off greys alcohol (M6-14).
      // A quick sale has no check yet: no cut-off to ask about, only the 4 AM stop.
      `/v1/venues/${venueId}/menu${props.sessionId ? `?session_id=${props.sessionId}` : checkId === "quick" ? "" : `?check_id=${checkId}`}`,
    );
    setItems(tree.categories.flatMap((c) => c.items));
    setAlcoholBlock(tree.alcohol.blocked);
  }, [venueId, props.sessionId, checkId]);
  const loadDraft = useCallback(async () => {
    const d = await api<{ lines: DraftLine[]; version: number }>(
      "GET",
      `/v1/venues/${venueId}/drafts/${checkId}`,
    );
    version.current = d.version;
    setLines(d.lines.map((l) => ({ ...l, option_ids: l.option_ids ?? [] })));
  }, [venueId, checkId]);
  const loadKitchen = useCallback(async () => {
    try {
      const k = await api<{ unsent_warn_min: number }>("GET", `/v1/venues/${venueId}/kitchen`);
      setWarnMin(k.unsent_warn_min);
    } catch {
      // Off (404 module_off) or unreachable: no Send to kitchen.
      setWarnMin(null);
    }
  }, [venueId]);
  const loadCheck = useCallback(async () => {
    if (checkId === "quick") return;
    const v = await api<{ lines: CheckLine[] }>("GET", `/v1/venues/${venueId}/checks/${checkId}`);
    setCheckLines(v.lines);
  }, [venueId, checkId]);
  const loadOrders = useCallback(async () => {
    if (!props.sessionId) return;
    const r = await api<{ orders: Order[] }>(
      "GET",
      `/v1/venues/${venueId}/orders?status=${OPEN}&session_id=${props.sessionId}`,
    );
    setOrders(r.orders);
  }, [venueId, props.sessionId]);

  useEffect(() => {
    Promise.all([loadMenu(), loadDraft(), loadOrders(), loadKitchen(), loadCheck()]).catch(() =>
      setError(t("shell.error.cantReach")),
    );
  }, [loadMenu, loadDraft, loadOrders, loadKitchen, loadCheck, t]);
  useEffect(
    () =>
      subscribe((events) => {
        if (
          events.length === 0 ||
          events.some(
            (e) =>
              e.type === "menu.changed" || e.type === "session.updated" || e.type === "tab.updated",
          )
        )
          void loadMenu();
        if (events.length === 0 || events.some((e) => e.type === "draft.updated")) void loadDraft();
        if (events.length === 0 || events.some((e) => e.type.startsWith("order.")))
          void loadOrders();
        if (events.length === 0 || events.some((e) => e.type.startsWith("module.")))
          void loadKitchen();
        if (
          events.length === 0 ||
          events.some((e) => e.type === "check.updated" || e.type.startsWith("order."))
        )
          void loadCheck().catch(() => undefined);
      }),
    [subscribe, loadMenu, loadDraft, loadOrders, loadKitchen, loadCheck],
  );

  const byVariant = useMemo(() => {
    const m = new Map<string, { item: Item; variant: Variant }>();
    for (const item of items ?? [])
      for (const v of item.variants) m.set(v.id, { item, variant: v });
    return m;
  }, [items]);

  useEffect(() => {
    if (props.refresh) void loadDraft();
  }, [props.refresh, loadDraft]);

  /** Saves the lines as rung; when another screen saved first, its lines win and show here. */
  // Saves run one after another, and Send or Pay waits for the last one (M6-05): a drink rung a
  // moment before Pay is saved before the sale clears the draft, never after it.
  const saving = useRef<Promise<void>>(Promise.resolve());
  const save = (next: readonly DraftLine[], undoable = true) => {
    if (undoable) history.current = [...history.current.slice(-49), lines];
    setLines(next);
    setSent(false);
    const run = async () => {
      try {
        const r = await api<{ version: number }>("PUT", `/v1/venues/${venueId}/drafts/${checkId}`, {
          lines: next,
          version: version.current,
        });
        version.current = r.version;
      } catch (e) {
        const err = e as ApiCallError;
        if (err?.code === "version_conflict") await loadDraft();
        else setError(err?.message ?? t("drinks.failed"));
      }
    };
    saving.current = saving.current.then(run);
    return saving.current;
  };

  const ring = (item: Item, variant: Variant, optionIds?: readonly string[]) => {
    // The usual is one tap: each choice's default is already set; a choice with none waits.
    // Food picked in its pop-up comes with its choices, and the time it was rung (K-05).
    const at = serverNowMs();
    const line: DraftLine = {
      variant_id: variant.id,
      qty: 1,
      option_ids:
        optionIds ??
        item.groups.flatMap((g) => g.options.filter((o) => o.is_default).map((o) => o.id)),
      ...(item.station === "kitchen" && at !== null ? { rung_at: new Date(at).toISOString() } : {}),
    };
    const same = lines.findIndex((l) => sameLine(l, line));
    void save(
      same >= 0
        ? lines.map((l, i) => (i === same ? { ...l, qty: Math.min(99, l.qty + 1) } : l))
        : [...lines, line],
    );
  };
  // A tap on the bar POS grid (M6-02) rings here, once per request.
  const lastRing = useRef(0);
  useEffect(() => {
    const req = props.ringRequest;
    if (!req || req.n === lastRing.current) return;
    const found = byVariant.get(req.variantId);
    if (!found) return;
    lastRing.current = req.n;
    ring(found.item, found.variant, req.optionIds);
    // ring reads the latest lines; the request is the only trigger.
  }, [props.ringRequest, byVariant]);
  const setQty = (i: number, qty: number) =>
    void save(
      qty <= 0
        ? lines.filter((_, j) => j !== i)
        : lines.map((l, j) => (j === i ? { ...l, qty } : l)),
    );
  const choose = (i: number, group: Group, optionId: string) =>
    void save(
      lines.map((l, j) =>
        j === i
          ? {
              ...l,
              option_ids: [
                ...l.option_ids.filter((o) => !group.options.some((x) => x.id === o)),
                ...(optionId ? [optionId] : []),
              ],
            }
          : l,
      ),
    );

  /** The first line held back by a choice with no default: the send button names it. */
  const missing = lines
    .map((l) => {
      const found = byVariant.get(l.variant_id);
      const group = found?.item.groups.find(
        (g) => g.required && !g.options.some((o) => l.option_ids.includes(o.id)),
      );
      return found && group ? { name: found.item.name, group: group.name.toLowerCase() } : null;
    })
    .find((x) => x !== null);

  const undo = () => {
    const previous = history.current.at(-1);
    if (!previous) return;
    history.current = history.current.slice(0, -1);
    void save(previous, false);
  };

  // Food (K-05): what's Not sent, in the draft and on the check, and the reminder on the venue's clock.
  const kitchenOn = warnMin !== null;
  const labelOf = (l: DraftLine) => {
    const found = byVariant.get(l.variant_id);
    if (!found) return "";
    const base =
      found.item.variants.length > 1
        ? `${found.item.name} · ${found.variant.name}`
        : found.item.name;
    const opts = found.item.groups
      .flatMap((g) => g.options)
      .filter((o) => l.option_ids.includes(o.id))
      .map((o) => o.name);
    return [base, ...opts].join(" · ");
  };
  const draftFood = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => byVariant.get(l.variant_id)?.item.station === "kitchen");
  const checkFood = checkLines.filter(
    (l) => l.kitchen && !l.kitchen.sent_at && l.kitchen.open_qty > 0,
  );
  const kitchenLines: KitchenLine[] = kitchenOn
    ? [
        ...checkFood.map((l) => ({
          key: `c:${l.id}`,
          label: l.description,
          qty: l.kitchen!.open_qty,
          note: l.kitchen!.kitchen_note ?? "",
          allergy: l.kitchen!.allergy,
        })),
        ...draftFood.map(({ l, i }) => ({
          key: `d:${i}`,
          label: labelOf(l),
          qty: l.qty,
          note: l.kitchen_note ?? "",
          allergy: l.kitchen_note_allergy ?? false,
        })),
      ]
    : [];
  const unsent = unsentFood(
    [
      ...checkFood.map((l) => ({ qty: l.kitchen!.open_qty, rungAt: l.kitchen!.rung_at })),
      ...draftFood.map(({ l }) => ({ qty: l.qty, rungAt: l.rung_at ?? null })),
    ],
    now?.epochMilliseconds ?? 0,
    warnMin ?? 5,
  );
  const unsentCount = kitchenOn ? unsent.count : 0;
  const onUnsentFood = props.onUnsentFood;
  useEffect(() => onUnsentFood?.(unsentCount), [onUnsentFood, unsentCount]);

  /**
   * Send to kitchen: the draft's round goes on first (with the hold check on a tab; the sale itself on
   * a quick sale), then one kitchen ticket for the food confirmed and the food that round put on.
   */
  const sendToKitchen = async ({ notes, name }: KitchenNotes) => {
    setError(null);
    setNotice(null);
    setKitchenDone(null);
    await saving.current;
    const withNotes = lines.map((l, i) => {
      const n = notes[`d:${i}`];
      return n
        ? {
            ...l,
            kitchen_note: n.note.trim() ? n.note.trim() : null,
            kitchen_note_allergy: n.allergy && n.note.trim() !== "",
          }
        : l;
    });
    if (props.onPay) {
      // A quick sale: Send to kitchen makes the sale, as Pay would, and sends its food.
      await props.onPay(withNotes, { name });
      return;
    }
    const before = new Set(checkLines.map((l) => l.id));
    if (lines.length > 0) {
      const answer = await api<{
        status?: string;
        waiting_for?: { name: string };
        error?: { code?: string };
      }>("POST", `/v1/venues/${venueId}/checks/${checkId}/orders`, {
        client_order_id: crypto.randomUUID(),
        lines: withNotes,
      });
      if (answer.error?.code === "payment_unknown") {
        setNotice(t("rail.holdChecking"));
        return;
      }
      if (answer.status === "approval_pending") {
        setNotice(t("rail.holdDeclined.waiting", { name: answer.waiting_for?.name ?? "" }));
        await loadDraft();
        return;
      }
      setLines([]);
      history.current = [];
    }
    const v = await api<{ lines: CheckLine[] }>("GET", `/v1/venues/${venueId}/checks/${checkId}`);
    const picked = v.lines.filter(
      (l) =>
        l.kitchen &&
        !l.kitchen.sent_at &&
        l.kitchen.open_qty > 0 &&
        (notes[`c:${l.id}`] !== undefined || !before.has(l.id)),
    );
    if (picked.length > 0) {
      const r = await api<{ sent_at: string }>(
        "POST",
        `/v1/venues/${venueId}/checks/${checkId}/kitchen-sends`,
        {
          lines: picked.map((l) => {
            const n = notes[`c:${l.id}`];
            return n
              ? {
                  line_id: l.id,
                  kitchen_note: n.note.trim() ? n.note.trim() : null,
                  kitchen_note_allergy: n.allergy,
                }
              : { line_id: l.id };
          }),
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      setKitchenDone(r.sent_at);
    }
    await Promise.all([loadDraft(), loadCheck(), loadOrders()]);
    props.onSent();
  };

  const send = async (payAnyway = false) => {
    // A quick sale paid with food not sent: the warning first, with Send to kitchen beside it.
    if (props.onPay && !payAnyway && unsentCount > 0) {
      setWarnPay(true);
      return;
    }
    setWarnPay(false);
    setError(null);
    setSending(true);
    try {
      await saving.current;
      setNotice(null);
      if (props.onPay) await props.onPay(lines);
      else {
        const answer = await api<{
          status?: string;
          waiting_for?: { name: string };
          error?: { code?: string };
        }>(
          "POST",
          giftTabId && giftName
            ? `/v1/venues/${venueId}/tabs/${giftTabId}/gift-order`
            : `/v1/venues/${venueId}/checks/${checkId}/orders`,
          giftTabId && giftName
            ? { client_order_id: crypto.randomUUID(), singer_id: giftFor, lines }
            : { client_order_id: crypto.randomUUID(), lines },
        );
        // The raise is being checked with Stripe: the round stays here, unsent.
        if (answer.error?.code === "payment_unknown") {
          setNotice(t("rail.holdChecking"));
          props.onSent();
          return;
        }
        if (answer.status === "approval_pending")
          setNotice(t("rail.holdDeclined.waiting", { name: answer.waiting_for?.name ?? "" }));
        else if (giftName) setNotice(t("gift.sent", { name: giftName }));
      }
      setGiftFor("");
      setLines([]);
      history.current = [];
      setSent(true);
      await Promise.all([loadDraft(), loadOrders()]);
      props.onSent();
    } catch (e) {
      const err = e as ApiCallError;
      const cut = err?.details?.["cut_off"] as { at: string; by: string | null } | undefined;
      setError(
        err?.details?.["reason"] === "hold_cap"
          ? t("rail.holdCapped")
          : giftName && err?.code === "cut_off"
            ? `${t("gift.cutOff", { name: giftName })}${cut ? ` · ${cutOffWords(cut)}` : ""}`
            : giftName && err?.code === "alcohol_closed"
              ? t("drinks.alcohol.closed")
              : (err?.message ?? t("drinks.failed")),
      );
    } finally {
      setSending(false);
    }
  };

  const q = query.trim().toLowerCase();
  const matches = q
    ? (items ?? []).filter((i) => i.name.toLowerCase().includes(q)).slice(0, 8)
    : [];
  const count = lines.reduce((n, l) => n + l.qty, 0);

  return (
    <section className="add-drinks" aria-label={t("drinks.title")}>
      <h3>{t("drinks.title")}</h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {props.search !== false && (
        <label className="grow">
          <span>{t("drinks.search")}</span>
          <input
            type="search"
            value={query}
            placeholder={t("drinks.search.hint")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      {items === null && q && <p role="status">{t("shell.loading")}</p>}
      {items !== null && q && matches.length === 0 && (
        <p className="muted small">{t("drinks.noMatch")}</p>
      )}
      {matches.length > 0 && (
        <ul className="drink-results">
          {matches.flatMap((item) =>
            item.variants.map((v) => {
              const refused = item.alcohol && alcoholBlock !== null;
              const out = item.out_tonight || v.out_tonight || refused;
              const why = refused
                ? t(
                    alcoholBlock === "window_closed"
                      ? "drinks.alcohol.closed"
                      : props.sessionId
                        ? "drinks.alcohol.cutOff"
                        : "drinks.alcohol.cutOffTab",
                  )
                : t("drinks.out");
              const label = item.variants.length > 1 ? `${item.name} · ${v.name}` : item.name;
              return (
                <li key={v.id}>
                  <button
                    type="button"
                    className={`drink ${out ? "out" : ""}`}
                    disabled={out}
                    aria-label={
                      out ? `${label} · ${why}` : `${label} · ${money(v.price_cents as never)}`
                    }
                    onClick={() => ring(item, v)}
                  >
                    <span data-guest-text>{label}</span>
                    <span>{out ? why : money(v.price_cents as never)}</span>
                  </button>
                </li>
              );
            }),
          )}
        </ul>
      )}

      {lines.length > 0 && (
        <div className="unsent" aria-label={t("drinks.unsent")}>
          <h4>{t("drinks.unsent")}</h4>
          <ul>
            {lines.map((l, i) => {
              const found = byVariant.get(l.variant_id);
              if (!found) return null;
              const { item, variant } = found;
              const label = item.variants.length > 1 ? `${item.name} · ${variant.name}` : item.name;
              const held = item.groups.some(
                (g) => g.required && !g.options.some((o) => l.option_ids.includes(o.id)),
              );
              const unit =
                variant.price_cents +
                item.groups
                  .flatMap((g) => g.options)
                  .filter((o) => l.option_ids.includes(o.id))
                  .reduce((s, o) => s + o.price_delta_cents, 0);
              return (
                <li key={`${l.variant_id}-${i}`} className={`unsent-line ${held ? "amber" : ""}`}>
                  <div className="unsent-head">
                    <span data-guest-text>{`${l.qty} × ${label}`}</span>
                    {kitchenOn && item.station === "kitchen" && (
                      <span className="kitchen-ns">{t("kitchen.notSent")}</span>
                    )}
                    <span>{money((unit * l.qty) as never)}</span>
                  </div>
                  <div className="unsent-controls">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t("drinks.fewer", { name: label })}
                      onClick={() => setQty(i, l.qty - 1)}
                    >
                      −
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t("drinks.more", { name: label })}
                      onClick={() => setQty(i, l.qty + 1)}
                    >
                      +
                    </button>
                    {item.groups.map((g) => {
                      const picked = g.options.find((o) => l.option_ids.includes(o.id));
                      return (
                        <select
                          key={g.id}
                          aria-label={`${label} · ${g.name}`}
                          value={picked?.id ?? ""}
                          onChange={(e) => choose(i, g, e.target.value)}
                        >
                          <option value="">
                            {g.required
                              ? t("drinks.pick", { group: g.name.toLowerCase() })
                              : t("drinks.none", { group: g.name.toLowerCase() })}
                          </option>
                          {g.options.map((o) => (
                            <option key={o.id} value={o.id} disabled={o.out_tonight}>
                              {o.out_tonight
                                ? `${o.name} · ${t("drinks.out")}`
                                : o.price_delta_cents > 0
                                  ? `${o.name} +${money(o.price_delta_cents as never)}`
                                  : o.name}
                            </option>
                          ))}
                        </select>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
          {giftTabId && singers.length > 0 && (
            <label className="gift-for">
              <span>{t("gift.label")}</span>
              <select value={giftFor} onChange={(e) => setGiftFor(e.target.value)}>
                <option value="">{t("gift.none")}</option>
                {singers.map((x) => (
                  <option key={x.id} value={x.id} data-guest-text>
                    {x.display_name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="actions">
            {history.current.length > 0 && (
              <button type="button" className="secondary" disabled={sending} onClick={undo}>
                {t("drinks.undo")}
              </button>
            )}
            <button
              type="button"
              className="primary send"
              disabled={missing !== undefined || count === 0 || sending}
              aria-busy={sending}
              onClick={() => void send()}
            >
              {sending
                ? t("drinks.sending")
                : missing
                  ? t("drinks.sendMissing", missing)
                  : props.onPay
                    ? t("drinks.pay", { count })
                    : giftName
                      ? t("gift.send", { count, name: giftName })
                      : t("drinks.send", { count })}
            </button>
          </div>
        </div>
      )}
      {warnPay && (
        <UnsentWarning
          count={unsentCount}
          anyway="pay"
          onSend={() => {
            setWarnPay(false);
            setKitchenOpen((n) => n + 1);
          }}
          onAnyway={() => void send(true)}
          onBack={() => setWarnPay(false)}
        />
      )}
      {kitchenOn && (
        <div className="kitchen-bar">
          {unsent.warn && <UnsentReminder count={unsentCount} />}
          <SendToKitchen
            lines={kitchenLines}
            needsName={checkId === "quick"}
            openRequest={(props.kitchenRequest ?? 0) + kitchenOpen}
            onSend={sendToKitchen}
          />
          {kitchenDone && (
            <p className="small kitchen-done" role="status">
              {t("kitchen.send.done", {
                time: time(kitchenDone, venueTimeZone),
              })}
            </p>
          )}
        </div>
      )}
      {notice ? (
        <p className="small warn" role="status">
          {notice}
        </p>
      ) : (
        sent && (
          <p className="small" role="status">
            {t("drinks.sent")}
          </p>
        )
      )}

      {orders.length > 0 && (
        <ul className="room-orders" aria-label={t("drinks.orders")}>
          {orders.map((o) => (
            <li key={o.id} className="small">
              <span data-guest-text>
                {o.items
                  .map((i) =>
                    [`${i.qty} × ${i.name_snapshot}`, ...i.options.map((x) => x.name)].join(" · "),
                  )
                  .join(", ")}
              </span>{" "}
              ·{" "}
              {t(staffOrderWordsKey(o), { age: "", name: "", time: "", reason: "" }).replace(
                / · $/,
                "",
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
