import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  POS_SECTIONS,
  Temporal,
  staffOrderWordsKey,
  type PosLayoutSections,
  type PosSection,
} from "@west4/shared";
import { api, ApiCallError } from "../api.js";
import { useClock } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";
import { readDevice } from "../device.js";
import { AddDrinks } from "./AddDrinks.js";
import { QuickSale } from "./QuickSale.js";

/**
 * The bar POS, the Rail (M6-02; Staff screens and the bar POS · The bar POS
 * screen, rules 1, 2, 4, 7, 9, 10 and 12; screens Rail): the bar computer's
 * home. Across the top, the room orders waiting at the bar, with Accept ·
 * print ticket, Ask the room to wait and Decline… (none after 4 AM for
 * alcohol). Left, the find box, All · Mine · Rooms, the bar tabs in the order
 * opened, the rooms, and tonight's closed tabs. Center, the station's ten
 * sections of 25 fixed slots (pos_layouts, M6-01), a search across the menu,
 * and 86. Right, the tab or room picked: its card and chips, what's on it,
 * and the round being rung, sent as a staff order accepted as it's placed.
 * Opening tabs, Quick sale, Close and Move come with M6-05 to M6-13.
 */
interface Variant {
  readonly id: string;
  readonly name: string;
  readonly price_cents: number;
  readonly out_tonight: boolean;
}
interface Option {
  readonly id: string;
  readonly name: string;
  readonly out_tonight: boolean;
}
interface Item {
  readonly id: string;
  readonly name: string;
  readonly button_name: string | null;
  readonly alcohol: boolean;
  readonly out_tonight: boolean;
  readonly variants: readonly Variant[];
  readonly groups: readonly {
    readonly id: string;
    readonly name: string;
    readonly options: readonly Option[];
  }[];
}
interface Tab {
  readonly id: string;
  readonly check_id: string;
  readonly check_label: string;
  readonly state: string;
  readonly open: boolean;
  readonly name: string;
  readonly label: string | null;
  readonly card: { readonly brand: string | null; readonly last4: string } | null;
  readonly hold_cents: number;
  readonly owner: { readonly id: string; readonly name: string | null } | null;
  readonly opened_at: string;
  readonly totals: { readonly total_cents: number } | null;
  readonly cut_off: { readonly at: string; readonly by: string | null } | null;
  readonly waiting_for: string | null;
  readonly unsent: number;
}
interface RoomTile {
  readonly room_id: string;
  readonly name: string;
  readonly session: {
    readonly id: string;
    readonly check_id: string | null;
    readonly started_at: string;
    readonly guest_name: string | null;
    readonly party_size: number;
    readonly ids_checked: number;
    readonly minutes: number;
    readonly room_time_cents: number;
    readonly tab_so_far_cents: number;
    readonly deposit_cents: number;
    readonly cut_off: { readonly by: string | null } | null;
  } | null;
}
interface WaitingOrder {
  readonly id: string;
  readonly room_name: string | null;
  readonly status: string;
  readonly placed_at: string;
  readonly cancel_reason: string | null;
  readonly decline_reason: string | null;
  readonly items: readonly {
    readonly qty: number;
    readonly name_snapshot: string;
    readonly alcohol: boolean;
  }[];
}
interface CheckLine {
  readonly id: number;
  readonly kind: string;
  readonly qty: number;
  readonly description: string;
  readonly amount_cents: number;
}
type Picked = { kind: "tab"; id: string } | { kind: "room"; id: string } | { kind: "quick" } | null;

const AMBER_S = 120;
const PINK_S = 240;

export function Rail() {
  const { t, money, time } = useT();
  const { state, lock, signInWithBadge } = useSession();
  const navigate = useNavigate();
  const { now } = useClock();
  const { subscribe } = useEvents();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const me = signedIn?.me.user;
  const meId = me?.id ?? "";
  // Sharing the terminal (M6-04): the locks, and whether the person signed in is on a break.
  const [terminal, setTerminal] = useState({
    idle_lock_min: 3,
    wipe_lock_sec: 10,
    on_break: false,
  });
  const [wipeLeft, setWipeLeft] = useState(0);
  const [sections, setSections] = useState<PosLayoutSections | null>(null);
  const [items, setItems] = useState<readonly Item[]>([]);
  const [windowClosed, setWindowClosed] = useState(false);
  const [tabs, setTabs] = useState<readonly Tab[]>([]);
  const [rooms, setRooms] = useState<readonly RoomTile[]>([]);
  const [waiting, setWaiting] = useState<readonly WaitingOrder[]>([]);
  const [section, setSection] = useState<PosSection>("favorites");
  const [query, setQuery] = useState("");
  const [find, setFind] = useState("");
  const [filter, setFilter] = useState<"all" | "mine" | "rooms">("all");
  const [picked, setPicked] = useState<Picked>({ kind: "quick" });
  const [lines, setLines] = useState<readonly CheckLine[]>([]);
  const [ringRequest, setRingRequest] = useState<{ variantId: string; n: number } | null>(null);
  const [draftRefresh, setDraftRefresh] = useState(0);
  const [leftOut, setLeftOut] = useState<string | null>(null);
  const [eightySix, setEightySix] = useState(false);
  const [choosing, setChoosing] = useState<Item | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const [layouts, menu, tabList, board, orders, term] = await Promise.all([
        api<{ tonight: { sections: PosLayoutSections } | null }>(
          "GET",
          `/v1/venues/${venueId}/pos/layouts?station=bar`,
        ),
        api<{ categories: { items: Item[] }[]; alcohol: { state: string } }>(
          "GET",
          `/v1/venues/${venueId}/menu`,
        ),
        api<{ tabs: Tab[] }>("GET", `/v1/venues/${venueId}/tabs`),
        api<{ rooms: RoomTile[] }>("GET", `/v1/venues/${venueId}/board`),
        api<{ orders: WaitingOrder[] }>("GET", `/v1/venues/${venueId}/orders?status=ringing,held`),
        api<{ idle_lock_min: number; wipe_lock_sec: number; on_break: boolean }>(
          "GET",
          `/v1/venues/${venueId}/pos/terminal`,
        ),
      ]);
      setTerminal(term);
      setSections(layouts.tonight?.sections ?? null);
      setItems(menu.categories.flatMap((c) => c.items));
      setWindowClosed(menu.alcohol.state !== "open");
      setTabs(tabList.tabs);
      setRooms(board.rooms.filter((r) => r.session?.check_id));
      setWaiting(orders.orders);
      setFailed(false);
      setLoaded(true);
    } catch {
      setFailed(true);
    }
    // Whoever is signed in: a badge takeover reloads everything as the new person.
  }, [venueId, meId]);
  useEffect(() => void load(), [load]);
  useEffect(() => setPicked({ kind: "quick" }), [meId]);

  const lockNow = useCallback(async () => {
    await lock();
    navigate("/sign-in", { replace: true });
  }, [lock, navigate]);

  // A badge on the reader takes over at once (M6-04): the last person's session ends, the new
  // person's own tabs and unsent drinks load. A refused badge leaves the screen locked.
  useEffect(() => {
    const west4 = window.west4;
    if (!west4) return;
    return west4.badge.onTap(({ url }) => {
      void (async () => {
        const device = await readDevice();
        if (!device) return;
        await api("POST", "/v1/auth/logout", {}).catch(() => undefined);
        try {
          await signInWithBadge(device, url);
        } catch {
          await lockNow();
        }
      })();
    });
  }, [signInWithBadge, lockNow]);

  // The idle lock (M6-04): pos.idleLockMin without a touch or a key locks the screen.
  const lastTouch = useRef(Date.now());
  useEffect(() => {
    const touched = () => {
      lastTouch.current = Date.now();
    };
    window.addEventListener("pointerdown", touched, true);
    window.addEventListener("keydown", touched, true);
    const id = setInterval(() => {
      if (Date.now() - lastTouch.current >= terminal.idle_lock_min * 60_000) void lockNow();
    }, 1000);
    return () => {
      window.removeEventListener("pointerdown", touched, true);
      window.removeEventListener("keydown", touched, true);
      clearInterval(id);
    };
  }, [terminal.idle_lock_min, lockNow]);

  // Wipe screen (M6-04): touch is off for pos.wipeLockSec.
  useEffect(() => {
    if (wipeLeft <= 0) return;
    const id = setTimeout(() => setWipeLeft((n) => n - 1), 1000);
    return () => clearTimeout(id);
  }, [wipeLeft]);
  useEffect(
    () =>
      subscribe((events) => {
        if (
          events.length === 0 ||
          events.some(
            (e) =>
              e.type.startsWith("order.") ||
              e.type.startsWith("check.") ||
              e.type.startsWith("tab.") ||
              e.type === "menu.changed" ||
              e.type === "session.updated" ||
              e.type === "settings.changed" ||
              e.type === "draft.updated",
          )
        )
          void load();
      }),
    [subscribe, load],
  );

  const checkId =
    picked?.kind === "tab"
      ? tabs.find((x) => x.id === picked.id)?.check_id
      : picked?.kind === "room"
        ? rooms.find((r) => r.room_id === picked.id)?.session?.check_id
        : undefined;
  const loadLines = useCallback(async () => {
    if (!checkId) return setLines([]);
    try {
      const v = await api<{ lines: CheckLine[] }>("GET", `/v1/venues/${venueId}/checks/${checkId}`);
      setLines(v.lines);
    } catch {
      setLines([]);
    }
  }, [venueId, checkId]);
  useEffect(() => void loadLines(), [loadLines, tabs, rooms]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const nowMs = now?.epochMilliseconds ?? Date.now();
  const ageS = (iso: string) =>
    Math.max(0, Math.floor((nowMs - Temporal.Instant.from(iso).epochMilliseconds) / 1000));
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const step = async (orderId: string, action: string, body: Record<string, unknown> = {}) => {
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/orders/${orderId}/${action}`, body);
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : t("barOrders.failed"));
    }
    await load();
  };
  const markOut = async (
    item: Item,
    target: { variant_id?: string; option_id?: string },
    out: boolean,
  ) => {
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/menu/items/${item.id}/out-tonight`, {
        out,
        ...target,
      });
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : t("barOrders.failed"));
    }
    setChoosing(null);
    setEightySix(false);
    await load();
  };

  /** A new tab or room starts with no tap waiting, so nothing rings on it by itself. */
  const pick = (next: Picked) => {
    setRingRequest(null);
    setLeftOut(null);
    setPicked(next);
  };
  /** Repeat round (M6-03): the last round into the unsent drinks, naming what was left out. */
  const repeat = async (tabId: string) => {
    setError(null);
    setLeftOut(null);
    try {
      const r = await api<{ left_out: { name: string; reason: string }[] }>(
        "POST",
        `/v1/venues/${venueId}/tabs/${tabId}/repeat-round`,
      );
      setDraftRefresh((n) => n + 1);
      if (r.left_out.length > 0)
        setLeftOut(
          t("rail.leftOut", {
            list: r.left_out
              .map(
                (x) =>
                  `${x.name} (${t(`rail.leftOut.${x.reason as "out" | "window_closed" | "cut_off"}`)})`,
              )
              .join(", "),
          }),
        );
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : t("drinks.failed"));
    }
  };
  const tapItem = (item: Item) => {
    if (eightySix) {
      // 86 the whole item at once, or pick a variant or a flavor.
      if (item.variants.length === 1 && item.groups.every((g) => g.options.length === 0))
        void markOut(item, {}, !item.out_tonight);
      else setChoosing(item);
      return;
    }
    if (!checkId && picked?.kind !== "quick") {
      setError(t("rail.pickFirst"));
      return;
    }
    if (item.variants.length > 1) {
      setChoosing(item);
      return;
    }
    const v = item.variants[0];
    if (v) setRingRequest((r) => ({ variantId: v.id, n: (r?.n ?? 0) + 1 }));
  };

  const q = query.trim().toLowerCase();
  const slots: (Item | null)[] = q
    ? items
        .filter(
          (i) =>
            i.name.toLowerCase().includes(q) || (i.button_name ?? "").toLowerCase().includes(q),
        )
        .slice(0, 25)
    : (sections?.[section] ?? []).map((id) => (id ? (byId.get(id) ?? null) : null));

  const f = find.trim().toLowerCase();
  const openTabs = tabs.filter((x) => x.open);
  const shownTabs =
    filter === "rooms"
      ? []
      : openTabs.filter(
          (x) =>
            (filter !== "mine" || x.owner?.id === me?.id) &&
            (!f ||
              x.name.toLowerCase().includes(f) ||
              (x.label ?? "").toLowerCase().includes(f) ||
              x.card?.last4.includes(f)),
        );
  const shownRooms =
    filter === "mine"
      ? []
      : [...rooms]
          .filter(
            (r) =>
              !f ||
              r.name.toLowerCase().includes(f) ||
              (r.session?.guest_name ?? "").toLowerCase().includes(f),
          )
          .sort((a, b) => a.session!.started_at.localeCompare(b.session!.started_at));
  const closed = tabs.filter((x) => !x.open);
  const tab = picked?.kind === "tab" ? tabs.find((x) => x.id === picked.id) : undefined;
  const room = picked?.kind === "room" ? rooms.find((r) => r.room_id === picked.id) : undefined;
  // What's on it: the drinks, songs and fixes, not the computed room time, tax and gratuity.
  const drinks = lines.filter(
    (l) => !["room_time", "tax", "gratuity", "card_surcharge", "cash_discount"].includes(l.kind),
  );

  const badges = (x: Tab) => [
    ...(x.cut_off ? [t("rail.badge.cutOff")] : []),
    ...(x.waiting_for ? [t("rail.badge.waiting", { name: x.waiting_for })] : []),
    ...(x.unsent > 0 ? [t("rail.badge.unsent", { n: x.unsent })] : []),
  ];

  return (
    <section className="rail" aria-label={t("menu.barPos")}>
      <header className="rail-top">
        <h1 className="rail-title">{t("menu.barPos")}</h1>
        <span className="who">
          {terminal.on_break && me ? t("rail.onBreak", { name: me.name.split(" ")[0]! }) : me?.name}
        </span>
        <ul className="rail-orders" aria-label={t("rail.roomOrders")}>
          {waiting.map((o) => {
            const age = ageS(o.placed_at);
            const tone = age >= PINK_S ? "pink" : age >= AMBER_S ? "amber" : "new";
            const alcohol = o.items.some((i) => i.alcohol);
            return (
              <li key={o.id} className={`rail-order ${tone}`} aria-label={o.room_name ?? ""}>
                <strong>{o.room_name}</strong>{" "}
                <span className="small">
                  {t(staffOrderWordsKey(o as never), { age: mmss(age) })}
                </span>
                <div className="small" data-guest-text>
                  {o.items.map((i) => `${i.qty} × ${i.name_snapshot}`).join(", ")}
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void step(o.id, "accept")}
                  >
                    {t("barOrders.accept")}
                  </button>
                  {o.status === "ringing" && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void step(o.id, "hold")}
                    >
                      {t("barOrders.hold")}
                    </button>
                  )}
                  {!(windowClosed && alcohol) && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setDeclining(o.id);
                        setReason("");
                      }}
                    >
                      {t("barOrders.decline")}
                    </button>
                  )}
                </div>
                {declining === o.id && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void step(o.id, "decline", { reason: reason.trim() }).then(() =>
                        setDeclining(null),
                      );
                    }}
                  >
                    <label>
                      <span>{t("barOrders.decline.reason")}</span>
                      <input
                        value={reason}
                        required
                        maxLength={200}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </label>
                    <p className="small muted">{t("rail.phonesExplain")}</p>
                    <button type="submit" className="primary" disabled={!reason.trim()}>
                      {t("barOrders.decline.send")}
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
        <span className="clock">{now ? time(now.toString(), timeZone) : ""}</span>
        <button
          type="button"
          className="secondary"
          onClick={() => setWipeLeft(terminal.wipe_lock_sec)}
        >
          {t("rail.wipe")}
        </button>
      </header>
      {wipeLeft > 0 && (
        <div
          className="wipe-overlay"
          role="status"
          onPointerDownCapture={(e) => e.stopPropagation()}
          onClickCapture={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {t("rail.wiping", { n: wipeLeft })}
        </div>
      )}

      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!loaded ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : (
        <div className="rail-body">
          <nav className="rail-left" aria-label={t("rail.tabs")}>
            <label>
              <input
                type="search"
                value={find}
                placeholder={t("rail.find")}
                aria-label={t("rail.find")}
                onChange={(e) => setFind(e.target.value)}
              />
            </label>
            <div className="rail-filters" role="group" aria-label={t("rail.filter")}>
              {(["all", "mine", "rooms"] as const).map((x) => (
                <button
                  key={x}
                  type="button"
                  aria-pressed={filter === x}
                  className={filter === x ? "chip on" : "chip"}
                  onClick={() => setFilter(x)}
                >
                  {t(`rail.filter.${x}`)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={picked?.kind === "quick" ? "rail-row quick on" : "rail-row quick"}
              aria-pressed={picked?.kind === "quick"}
              onClick={() => pick({ kind: "quick" })}
            >
              <span className="name">{t("rail.quickSale")}</span>
            </button>
            <ul className="rail-list" aria-label={t("rail.barTabs")}>
              {shownTabs.map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    className={
                      picked?.kind === "tab" && picked.id === x.id ? "rail-row on" : "rail-row"
                    }
                    aria-pressed={picked?.kind === "tab" && picked.id === x.id}
                    onClick={() => pick({ kind: "tab", id: x.id })}
                  >
                    <span className="name" data-guest-text>
                      {x.name}
                    </span>
                    <span className="amount">{money((x.totals?.total_cents ?? 0) as never)}</span>
                    {badges(x).map((b) => (
                      <span key={b} className="badge">
                        {b}
                      </span>
                    ))}
                  </button>
                </li>
              ))}
            </ul>
            <ul className="rail-list" aria-label={t("rail.rooms")}>
              {shownRooms.map((r) => (
                <li key={r.room_id}>
                  <button
                    type="button"
                    className={
                      picked?.kind === "room" && picked.id === r.room_id
                        ? "rail-row on"
                        : "rail-row"
                    }
                    aria-pressed={picked?.kind === "room" && picked.id === r.room_id}
                    onClick={() => pick({ kind: "room", id: r.room_id })}
                  >
                    <span className="name" data-guest-text>
                      {r.name}
                    </span>
                    <span className="amount">{money(r.session!.tab_so_far_cents as never)}</span>
                    <span className="small muted">
                      {t("rail.roomOpened", {
                        time: time(r.session!.started_at, timeZone),
                        min: r.session!.minutes,
                        amount: money(r.session!.room_time_cents as never),
                      })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {closed.length > 0 && (
              <details>
                <summary>{t("rail.closed", { n: closed.length })}</summary>
                <ul className="rail-list">
                  {closed.map((x) => (
                    <li key={x.id} className="small" data-guest-text>
                      {x.name}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </nav>

          <div className="rail-center">
            <div className="rail-sections" role="tablist" aria-label={t("barPos.sections")}>
              {POS_SECTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={!q && s === section}
                  className={!q && s === section ? "chip on" : "chip"}
                  onClick={() => {
                    setSection(s);
                    setQuery("");
                  }}
                >
                  {t(`barPos.section.${s}`)}
                </button>
              ))}
            </div>
            <div className="rail-tools">
              <input
                type="search"
                value={query}
                aria-label={t("rail.search")}
                placeholder={t("rail.search")}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button
                type="button"
                className={eightySix ? "primary" : "secondary"}
                aria-pressed={eightySix}
                onClick={() => {
                  setEightySix(!eightySix);
                  setChoosing(null);
                }}
              >
                {t("rail.86")}
              </button>
            </div>
            {eightySix && (
              <p className="small" role="status">
                {t("rail.86.hint")}
              </p>
            )}
            <ol
              className="rail-grid"
              aria-label={q ? t("rail.search") : t(`barPos.section.${section}`)}
            >
              {slots.map((item, i) => {
                if (!item)
                  return <li key={`empty-${i}`} className="slot empty" aria-hidden="true" />;
                const out = item.out_tonight || item.variants.every((v) => v.out_tonight);
                const name = item.button_name ?? item.name;
                const price = item.variants[0]?.price_cents ?? 0;
                return (
                  <li key={item.id} className={out ? "slot out" : "slot"}>
                    <button
                      type="button"
                      disabled={out && !eightySix}
                      aria-label={
                        out ? `${name} · ${t("drinks.out")}` : `${name} · ${money(price as never)}`
                      }
                      onClick={() => tapItem(item)}
                    >
                      <span data-guest-text>{name}</span>
                      <span className="small">{out ? t("drinks.out") : money(price as never)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            {choosing && (
              <div className="sheet" role="dialog" aria-label={choosing.name}>
                <h3 data-guest-text>{choosing.name}</h3>
                {eightySix && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void markOut(choosing, {}, !choosing.out_tonight)}
                  >
                    {choosing.out_tonight ? t("rail.86.restoreAll") : t("rail.86.all")}
                  </button>
                )}
                {choosing.variants.length > 1 &&
                  choosing.variants.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      className="secondary"
                      disabled={!eightySix && v.out_tonight}
                      onClick={() => {
                        if (eightySix) void markOut(choosing, { variant_id: v.id }, !v.out_tonight);
                        else {
                          setRingRequest((r) => ({ variantId: v.id, n: (r?.n ?? 0) + 1 }));
                          setChoosing(null);
                        }
                      }}
                    >
                      <span data-guest-text>{v.name}</span>{" "}
                      {v.out_tonight ? t("drinks.out") : money(v.price_cents as never)}
                    </button>
                  ))}
                {eightySix &&
                  choosing.groups.flatMap((g) =>
                    g.options.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        className="secondary"
                        onClick={() => void markOut(choosing, { option_id: o.id }, !o.out_tonight)}
                      >
                        <span data-guest-text>{o.name}</span>
                        {o.out_tonight ? ` · ${t("drinks.out")}` : ""}
                      </button>
                    )),
                  )}
                <button type="button" className="link" onClick={() => setChoosing(null)}>
                  {t("rail.backToSale")}
                </button>
              </div>
            )}
          </div>

          <aside className="rail-right" aria-label={t("rail.picked")}>
            {picked?.kind === "quick" ? (
              <QuickSale
                venueId={venueId}
                ringRequest={ringRequest}
                refresh={draftRefresh}
                onChanged={() => void load()}
              />
            ) : !tab && !room ? (
              <p className="muted">{t("rail.pickFirst")}</p>
            ) : (
              <>
                <h2 data-guest-text>{tab ? tab.name : room!.name}</h2>
                <div className="chips">
                  {tab?.card && (
                    <span className="chip">
                      {tab.card.brand} ··{tab.card.last4}
                    </span>
                  )}
                  {tab && (
                    <span className="chip">
                      {t("rail.hold", { amount: money(tab.hold_cents as never) })}
                    </span>
                  )}
                  {room?.session && (
                    <span className="chip">
                      {t("rail.ids", { n: room.session.ids_checked, of: room.session.party_size })}
                    </span>
                  )}
                  {(tab?.cut_off || room?.session?.cut_off) && (
                    <span className="chip warn">{t("rail.badge.cutOff")}</span>
                  )}
                  {tab?.waiting_for && (
                    <span className="chip warn">
                      {t("rail.badge.waiting", { name: tab.waiting_for })}
                    </span>
                  )}
                </div>
                <ul className="on-tab" aria-label={t("rail.onTab")}>
                  {drinks.map((l) => (
                    <li key={String(l.id)}>
                      <span data-guest-text>
                        {l.qty > 1 ? `${l.qty} × ${l.description}` : l.description}
                      </span>
                      <span>{money(l.amount_cents as never)}</span>
                    </li>
                  ))}
                </ul>
                <p className="total">
                  {t("rail.total")}{" "}
                  <strong>
                    {money(
                      ((tab ? tab.totals?.total_cents : room?.session?.tab_so_far_cents) ??
                        0) as never,
                    )}
                  </strong>
                </p>
                {tab && (
                  <button
                    type="button"
                    className="secondary repeat"
                    onClick={() => void repeat(tab.id)}
                  >
                    {t("rail.repeat")}
                  </button>
                )}
                {leftOut && (
                  <p className="small" role="status">
                    {leftOut}
                  </p>
                )}
                {checkId && (
                  <AddDrinks
                    refresh={draftRefresh}
                    key={checkId}
                    venueId={venueId}
                    checkId={checkId}
                    sessionId={room?.session?.id ?? null}
                    search={false}
                    ringRequest={ringRequest}
                    onSent={() => void load()}
                  />
                )}
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
