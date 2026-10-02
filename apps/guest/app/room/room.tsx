"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EventClient, guestOrderWords, t, type MessageKey } from "@west4/shared";
import { YourBill, type GuestBill, type ShareAnswer } from "../bill/your-bill";

/**
 * The room page on a joined guest's phone (M3-08, M3-09; screens Order notes
 * 1, 2 and 13): the room and its code, the menu with 86'd drinks greyed in
 * place, a choice with no default asked before adding, the cart ("Your order
 * · not sent yet"), and each order's status from the server in the guest's
 * words, with Cancel while it rings or is asked to wait. Live through the
 * room's channel, with a slow refresh behind it.
 */
interface RoomSession {
  readonly venue: { readonly id: string; readonly name: string; readonly slug: string };
  readonly room: { readonly id: string; readonly name: string };
  readonly code: string | null;
  readonly is_host: boolean;
  readonly moved: { readonly from: string; readonly to: string } | null;
  readonly rotated: boolean;
  readonly host_lock: boolean;
  readonly host_name: string | null;
  /** Why alcohol is hidden right now: the window closed, or a cut-off (M3-20). */
  readonly alcohol_blocked?: "window_closed" | "cut_off" | null;
  /** A tablet between sessions (M3-12). */
  readonly available?: boolean;
  /** The check is presented (M4-08): the bill is ready and ordering is closed. */
  readonly ordering_locked?: boolean;
}
interface Bill {
  readonly minutes: number;
  readonly room_time_cents: number;
  readonly drinks_cents: number;
  readonly tab_so_far_cents: number;
  /** What's left to the minimum spend (M4-27); null with none, as at West 4. */
  readonly min_spend_left_cents?: number | null;
  readonly per_minute_cents: number;
  readonly party_size: number;
  readonly deposit_cents: number;
  readonly stay_on_until: string | null;
  readonly wrap_up_at: string | null;
  readonly time_zone: string;
  /** After Present (M4-16): the bill itself, with the ways to pay. */
  readonly presented?: GuestBill | null;
}
const CALLS = ["mic", "tv", "check", "other"] as const;
interface Round {
  readonly order_id: string;
  readonly lines: readonly { qty: number; name: string; options: readonly string[] }[];
  readonly total_cents: number;
  readonly left_out: readonly { name: string; reason: string }[];
}
/** "4 AM" on the hour, "11:05 PM" otherwise, in the venue's zone. */
const clockTime = (iso: string, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
  return parts.replace(":00 ", " ");
};
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
  readonly description: string | null;
  readonly out_tonight: boolean;
  readonly variants: readonly Variant[];
  readonly groups: readonly Group[];
}
interface Category {
  readonly id: string;
  readonly name: string;
  readonly items: readonly Item[];
}
interface CartLine {
  readonly variant_id: string;
  readonly option_ids: readonly string[];
  readonly qty: number;
  readonly label: string;
  readonly unit_cents: number;
}
interface GuestOrder {
  readonly id: string;
  readonly status: string;
  readonly cancel_reason: string | null;
  readonly decline_reason: string | null;
  readonly items: readonly { qty: number; name: string; options: readonly string[] }[];
  readonly can_cancel: boolean;
}

const REFRESH_MS = 10_000;

/**
 * Where the live channel connects. The page's /v1 calls go through Next's rewrite, which doesn't
 * carry a WebSocket upgrade, so NEXT_PUBLIC_EVENTS_ORIGIN names the API's origin when it's on
 * another host; locally the API is on port 3000 beside the guest web's 3001. The room cookie
 * belongs to the host name, so it reaches either port.
 */
function eventsOrigin(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const configured = process.env["NEXT_PUBLIC_EVENTS_ORIGIN"];
  if (configured) return configured.replace(/\/+$/, "");
  return location.port === "3001"
    ? `${scheme}://${location.hostname}:3000`
    : `${scheme}://${location.host}`;
}
const money = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
const newOrderId = () => `room-${crypto.randomUUID()}`;
/** A choice the bar can't guess: required, with no default. */
const mustChoose = (item: Item) =>
  item.groups.some((g) => g.required && !g.options.some((o) => o.is_default));

/** How the page calls the room routes: a phone's plain fetch with its cookie, or a tablet's signed one. */
export type RoomApi = (
  path: string,
  init?: { method?: string; body?: string },
) => Promise<Response>;
const plainApi: RoomApi = (path, init) =>
  fetch(path, {
    cache: "no-store",
    method: init?.method ?? "GET",
    ...(init?.body ? { body: init.body, headers: { "content-type": "application/json" } } : {}),
  });

export function RoomPage({
  api = plainApi,
  tablet = false,
}: { api?: RoomApi; tablet?: boolean } = {}) {
  const [room, setRoom] = useState<RoomSession | null>(null);
  const [menu, setMenu] = useState<readonly Category[] | null>(null);
  const [orders, setOrders] = useState<readonly GuestOrder[]>([]);
  const [bill, setBill] = useState<Bill | null>(null);
  const [rounds, setRounds] = useState<readonly Round[]>([]);
  const [called, setCalled] = useState(false);
  const [cart, setCart] = useState<readonly CartLine[]>([]);
  const [choosing, setChoosing] = useState<{
    item: Item;
    variant: Variant;
    picks: Record<string, string>;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState<"ended" | "out" | null>(null);
  // One id per cart, kept across retries, so a send that's retried can't order twice.
  const clientOrderId = useRef(newOrderId());

  const loadOrders = useCallback(async () => {
    const [r, b, a] = await Promise.all([
      api("/v1/public/room-session/orders").catch(() => null),
      api("/v1/public/room-session/bill").catch(() => null),
      api("/v1/public/room-session/same-again").catch(() => null),
    ]);
    if (r?.ok) setOrders(((await r.json()) as { orders: GuestOrder[] }).orders);
    if (b?.ok) setBill((await b.json()) as Bill);
    if (a?.ok) setRounds(((await a.json()) as { rounds: Round[] }).rounds);
  }, [api]);
  const load = useCallback(async () => {
    const r = await api("/v1/public/room-session").catch(() => null);
    if (!r) return null;
    if (!r.ok) {
      // A paid room goes to cleaning and its session ends (M4-16): the phone keeps the paid bill.
      if (r.status === 404) {
        const b = await api("/v1/public/room-session/bill").catch(() => null);
        const paid = b?.ok ? ((await b.json()) as { presented?: GuestBill | null }) : null;
        if (paid?.presented) {
          const presented = paid.presented;
          setBill((prev) => ({ ...(prev as Bill), presented }));
        }
      }
      setGone(r.status === 404 ? "ended" : "out");
      return null;
    }
    const s = (await r.json()) as RoomSession;
    setRoom(s);
    if (s.moved) setNotice(t("en", "guestRoom.moved", { room: s.moved.to, code: s.code ?? "" }));
    else if (s.rotated)
      setNotice(t("en", "guestRoom.newCode", { room: s.room.name, code: s.code ?? "" }));
    if (!s.available) await loadOrders();
    return s;
  }, [api, loadOrders]);
  const loadMenu = useCallback(async (slug: string) => {
    const r = await fetch(`/v1/public/venues/${encodeURIComponent(slug)}/menu`, {
      cache: "no-store",
    }).catch(() => null);
    if (r?.ok) setMenu(((await r.json()) as { categories: Category[] }).categories);
  }, []);

  useEffect(() => {
    let client: EventClient | undefined;
    void load().then((s) => {
      if (!s || s.available) return;
      void loadMenu(s.venue.slug);
      // A tablet can't sign a WebSocket upgrade, so it refreshes on the timer alone (M3-12).
      if (tablet) return;
      // The room's live channel: order steps, a move or a new code, a menu change.
      client = new EventClient({
        url: `${eventsOrigin()}/v1/venues/${s.venue.id}/events`,
        connect: (url) => new WebSocket(url) as never,
        onRefetch: (events) => {
          if (events.some((e) => e.type === "menu.changed")) void loadMenu(s.venue.slug);
          if (events.some((e) => e.type.startsWith("session.") || e.type === "room.updated"))
            void load();
          else void loadOrders();
        },
        onFullRefetch: () => void load(),
        maxBackoffMs: 60_000,
      });
      client.start();
    });
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      clearInterval(timer);
      client?.stop();
    };
  }, [load, loadMenu, loadOrders, tablet]);

  const add = (item: Item, variant: Variant, optionIds: readonly string[]) => {
    const options = item.groups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id));
    const label = [
      item.variants.length > 1 ? `${item.name} · ${variant.name}` : item.name,
      ...options.map((o) => o.name),
    ].join(" · ");
    const unit = variant.price_cents + options.reduce((s, o) => s + o.price_delta_cents, 0);
    setCart((lines) => {
      const same = lines.findIndex(
        (l) => l.variant_id === variant.id && l.option_ids.join() === [...optionIds].sort().join(),
      );
      return same >= 0
        ? lines.map((l, i) => (i === same ? { ...l, qty: Math.min(20, l.qty + 1) } : l))
        : [
            ...lines,
            {
              variant_id: variant.id,
              option_ids: [...optionIds].sort(),
              qty: 1,
              label,
              unit_cents: unit,
            },
          ];
    });
  };
  const tap = (item: Item, variant: Variant) => {
    const defaults = item.groups.flatMap((g) =>
      g.options.filter((o) => o.is_default).map((o) => o.id),
    );
    if (mustChoose(item)) {
      const picks: Record<string, string> = {};
      for (const g of item.groups) {
        const d = g.options.find((o) => o.is_default);
        if (d) picks[g.id] = d.id;
      }
      setChoosing({ item, variant, picks });
    } else add(item, variant, defaults);
  };
  const setQty = (i: number, qty: number) =>
    setCart((lines) =>
      qty <= 0
        ? lines.filter((_, j) => j !== i)
        : lines.map((l, j) => (j === i ? { ...l, qty } : l)),
    );

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api("/v1/public/room-session/orders", {
        method: "POST",
        body: JSON.stringify({
          client_order_id: clientOrderId.current,
          lines: cart.map((l) => ({
            variant_id: l.variant_id,
            qty: l.qty,
            option_ids: l.option_ids,
          })),
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string };
        };
        if (body.error?.code === "session_expired") await load();
        setError(body.error?.message ?? t("en", "guestRoom.sendFailed"));
        return;
      }
      setCart([]);
      clientOrderId.current = newOrderId();
      await loadOrders();
    } catch {
      setError(t("en", "guestRoom.sendFailed"));
    } finally {
      setBusy(false);
    }
  };
  const again = async (orderId: string) => {
    setError(null);
    const r = await api("/v1/public/room-session/same-again", {
      method: "POST",
      body: JSON.stringify({ order_id: orderId, client_order_id: newOrderId() }),
    }).catch(() => null);
    if (!r?.ok) {
      const body = r
        ? ((await r.json().catch(() => ({}))) as { error?: { message?: string } })
        : {};
      setError(body.error?.message ?? t("en", "guestRoom.sendFailed"));
    }
    await loadOrders();
  };
  const call = async (kind: (typeof CALLS)[number]) => {
    const r = await api("/v1/public/room-session/calls", {
      method: "POST",
      body: JSON.stringify({ kind }),
    }).catch(() => null);
    setCalled(r?.ok === true);
  };
  const lock = async (on: boolean) => {
    await api("/v1/public/room-session/lock", {
      method: "POST",
      body: JSON.stringify({ on }),
    }).catch(() => null);
    await load();
  };
  const cancel = async (orderId: string) => {
    await api(`/v1/public/room-session/orders/${orderId}/cancel`, { method: "POST" }).catch(
      () => null,
    );
    await loadOrders();
  };

  if (gone === "ended" && bill?.presented)
    return (
      <main className="guest room-page">
        {room && (
          <header>
            <p className="venue">{room.venue.name}</p>
            <h1>{room.room.name}</h1>
          </header>
        )}
        <YourBill bill={bill.presented} />
      </main>
    );
  if (gone)
    return (
      <main className="guest">
        <p role="status">
          {gone === "ended" ? t("en", "guestRoom.ended") : t("en", "guestRoom.hostLink.failed")}
        </p>
      </main>
    );
  if (!room) return <main className="guest" aria-busy="true" />;
  if (room.available)
    return (
      <main className="guest room-page available">
        <h1>{room.room.name}</h1>
        <p className="big" role="status">
          {t("en", "guestRoom.available")}
        </p>
      </main>
    );
  const total = cart.reduce((s, l) => s + l.unit_cents * l.qty, 0);
  const count = cart.reduce((s, l) => s + l.qty, 0);

  return (
    <main className="guest room-page">
      <header>
        <p className="venue">{room.venue.name}</p>
        <h1>
          {room.code
            ? t("en", "guestRoom.header", { room: room.room.name, code: room.code })
            : room.room.name}
        </h1>
        {!tablet && <p>{room.is_host ? t("en", "guestRoom.host") : t("en", "guestRoom.friend")}</p>}
      </header>
      {room.ordering_locked && (
        <p className="notice bill-ready" role="status">
          {t("en", "guestRoom.billReady")}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      {room.ordering_locked && bill?.presented ? (
        <YourBill
          bill={bill.presented}
          {...(tablet
            ? {}
            : {
                payLink: async () => {
                  const r = await api("/v1/public/room-session/pay-link", { method: "POST" });
                  return r.ok ? ((await r.json()) as { url: string }).url : null;
                },
                payShare: async (kind: "even" | "items", name: string | null) => {
                  const r = await api("/v1/public/room-session/shares", {
                    method: "POST",
                    body: JSON.stringify({ kind, name }),
                  });
                  return r.ok ? ((await r.json()) as ShareAnswer) : null;
                },
                payOnFile: async (paymentId: string) => {
                  const r = await api(`/v1/public/room-session/payments/${paymentId}/confirm`, {
                    method: "POST",
                  });
                  if (!r.ok) return null;
                  const done = (await r.json()) as {
                    status: "paid" | "declined" | "checking";
                  };
                  void loadOrders();
                  return done.status;
                },
                payCash: async () =>
                  (
                    await api("/v1/public/room-session/calls", {
                      method: "POST",
                      body: JSON.stringify({ kind: "check" }),
                    })
                  ).ok,
              })}
        />
      ) : (
        bill && (
          <section className="bill" aria-labelledby="bill-h">
            <h2 id="bill-h">{t("en", "guestRoom.bill")}</h2>
            <dl>
              <dt>{t("en", "guestRoom.bill.roomTime", { min: bill.minutes })}</dt>
              <dd>{money(bill.room_time_cents)}</dd>
              <dt>{t("en", "guestRoom.bill.drinks")}</dt>
              <dd>{money(bill.drinks_cents)}</dd>
              <dt>
                <strong>{t("en", "guestRoom.bill.total")}</strong>
              </dt>
              <dd>
                <strong>{money(bill.tab_so_far_cents)}</strong>
              </dd>
            </dl>
            {(bill.min_spend_left_cents ?? 0) > 0 && (
              <p className="notice">
                {t("en", "minSpend.left", { amount: money(bill.min_spend_left_cents ?? 0) })}
              </p>
            )}
            <p className="hint">
              {t("en", "guestRoom.bill.note", {
                rate: money(bill.per_minute_cents),
                party: bill.party_size,
              })}
            </p>
            {bill.deposit_cents > 0 && (
              <p className="hint">
                {t("en", "guestRoom.bill.deposit", { amount: money(bill.deposit_cents) })}
              </p>
            )}
            {bill.stay_on_until && (
              <p>
                {t("en", "guestRoom.stayOn", {
                  time: clockTime(bill.stay_on_until, bill.time_zone),
                })}
              </p>
            )}
            {bill.wrap_up_at && (
              <p className="notice">
                {t("en", "guestRoom.wrapUp", { time: clockTime(bill.wrap_up_at, bill.time_zone) })}
              </p>
            )}
          </section>
        )
      )}

      {room.is_host ? (
        <label className="lock">
          <input
            type="checkbox"
            checked={room.host_lock}
            onChange={(e) => void lock(e.target.checked)}
          />
          <span>
            {t("en", "guestRoom.lock")}
            <small>{t("en", "guestRoom.lock.hint")}</small>
          </span>
        </label>
      ) : (
        room.host_lock && (
          <p className="notice" role="status">
            {t("en", "guestRoom.locked", { name: room.host_name ?? t("en", "guestRoom.theHost") })}
          </p>
        )
      )}

      {orders.length > 0 && (
        <section aria-labelledby="orders-h">
          <h2 id="orders-h">{t("en", "guestRoom.orders")}</h2>
          <ul className="orders">
            {orders.map((o) => {
              const words = guestOrderWords(o);
              return (
                <li key={o.id} className="order">
                  <p className="what">
                    {o.items
                      .map((i) => [`${i.qty} × ${i.name}`, ...i.options].join(" · "))
                      .join(", ")}
                  </p>
                  <p className="status" aria-live="polite">
                    {t("en", words.key as MessageKey, { room: room.room.name })}
                    {words.reason ? ` · ${words.reason}` : ""}
                  </p>
                  {o.can_cancel && (
                    <button type="button" className="secondary" onClick={() => void cancel(o.id)}>
                      {t("en", "guestRoom.cancel")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {cart.length > 0 && (
        <section className="cart" aria-labelledby="cart-h">
          <h2 id="cart-h">{t("en", "guestRoom.cart")}</h2>
          <ul>
            {cart.map((l, i) => (
              <li key={`${l.variant_id}-${l.option_ids.join()}`}>
                <span>{`${l.qty} × ${l.label}`}</span>
                <span className="qty">
                  <button
                    type="button"
                    aria-label={t("en", "guestRoom.fewer", { name: l.label })}
                    onClick={() => setQty(i, l.qty - 1)}
                  >
                    −
                  </button>
                  <button
                    type="button"
                    aria-label={t("en", "guestRoom.more", { name: l.label })}
                    onClick={() => setQty(i, l.qty + 1)}
                  >
                    +
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {error && <p role="alert">{error}</p>}
          <button
            type="button"
            disabled={
              busy ||
              count === 0 ||
              room.ordering_locked === true ||
              (room.host_lock && !room.is_host)
            }
            onClick={() => void send()}
          >
            {busy
              ? t("en", "guestRoom.sending")
              : t("en", "guestRoom.send", { count, total: money(total) })}
          </button>
        </section>
      )}

      {rounds.length > 0 && (
        <section className="again" aria-labelledby="again-h">
          <h2 id="again-h">{t("en", "guestRoom.again")}</h2>
          <ul>
            {rounds.map((r) => (
              <li key={r.order_id}>
                <p>
                  {r.lines
                    .map((l) => [`${l.qty} × ${l.name}`, ...l.options].join(" · "))
                    .join(", ")}
                  {" · "}
                  {money(r.total_cents)}
                </p>
                {r.left_out.length > 0 && (
                  <p className="hint">
                    {t("en", "guestRoom.again.without", {
                      names: r.left_out.map((x) => x.name).join(", "),
                    })}
                  </p>
                )}
                <button type="button" onClick={() => void again(r.order_id)}>
                  {t("en", "guestRoom.again.order")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="calls" aria-labelledby="call-h">
        <h2 id="call-h">{t("en", "guestRoom.call")}</h2>
        <div className="call-buttons">
          {CALLS.map((k) => (
            <button key={k} type="button" className="secondary" onClick={() => void call(k)}>
              {t("en", `guestRoom.call.${k}` as MessageKey)}
            </button>
          ))}
        </div>
        {called && <p role="status">{t("en", "guestRoom.call.sent")}</p>}
      </section>

      <section aria-labelledby="menu-h">
        <h2 id="menu-h">{t("en", "guestRoom.menu")}</h2>
        {room.alcohol_blocked && (
          <p className="notice" role="status">
            {t(
              "en",
              room.alcohol_blocked === "cut_off"
                ? "orders.guest.cut_off"
                : "guestRoom.alcoholClosed",
            )}
          </p>
        )}
        {menu === null ? (
          <p aria-busy="true">{t("en", "guestRoom.menu.loading")}</p>
        ) : (
          menu.map((cat) => (
            <section key={cat.id} className="menu-section" aria-label={cat.name}>
              <h3>{cat.name}</h3>
              <ul>
                {cat.items
                  .filter((item) => !(item.alcohol && room.alcohol_blocked))
                  .flatMap((item) =>
                    item.variants.map((v) => {
                      const out = item.out_tonight || v.out_tonight;
                      const name =
                        item.variants.length > 1 ? `${item.name} · ${v.name}` : item.name;
                      return (
                        <li key={v.id}>
                          <button
                            type="button"
                            className={out ? "menu-item out" : "menu-item"}
                            disabled={out}
                            aria-label={
                              out
                                ? `${name} · ${t("en", "guestRoom.out")}`
                                : `${name} · ${money(v.price_cents)}`
                            }
                            onClick={() => tap(item, v)}
                          >
                            <span>{name}</span>
                            <span>{out ? t("en", "guestRoom.out") : money(v.price_cents)}</span>
                          </button>
                        </li>
                      );
                    }),
                  )}
              </ul>
            </section>
          ))
        )}
      </section>

      {choosing && (
        <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="choose-h">
          <h2 id="choose-h">{choosing.item.name}</h2>
          <p>{t("en", "guestRoom.which")}</p>
          {choosing.item.groups.map((g) => (
            <fieldset key={g.id}>
              <legend>{g.name}</legend>
              {g.options.map((o) => (
                <label key={o.id} className={o.out_tonight ? "out" : undefined}>
                  <input
                    type="radio"
                    name={g.id}
                    value={o.id}
                    disabled={o.out_tonight}
                    checked={choosing.picks[g.id] === o.id}
                    onChange={() =>
                      setChoosing({ ...choosing, picks: { ...choosing.picks, [g.id]: o.id } })
                    }
                  />
                  {o.out_tonight
                    ? `${o.name} · ${t("en", "guestRoom.out")}`
                    : o.price_delta_cents > 0
                      ? `${o.name} +${money(o.price_delta_cents)}`
                      : o.name}
                </label>
              ))}
            </fieldset>
          ))}
          <button
            type="button"
            disabled={choosing.item.groups.some((g) => g.required && !choosing.picks[g.id])}
            onClick={() => {
              add(choosing.item, choosing.variant, Object.values(choosing.picks));
              setChoosing(null);
            }}
          >
            {t("en", "guestRoom.add")}
          </button>
          <button type="button" className="secondary" onClick={() => setChoosing(null)}>
            {t("en", "guestRoom.notNow")}
          </button>
        </div>
      )}
    </main>
  );
}
