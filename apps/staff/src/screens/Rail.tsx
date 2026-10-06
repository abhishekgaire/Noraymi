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
import { useClock, useVenueTime } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";
import { readDevice } from "../device.js";
import { AddDrinks } from "./AddDrinks.js";
import { CutOffTab } from "./CutOff.js";
import { QuickSale } from "./QuickSale.js";
import { NewTab } from "./NewTab.js";
import { CloseTab } from "./CloseTab.js";
import { SplitPanel, type Share, type Split } from "./SplitPanel.js";
import { TapPayment } from "./TapPayment.js";
import { CashPanel } from "./CashPanel.js";
import { RefundSheet } from "./RefundSheet.js";
import { FixPanel, isFixable, type PendingFix } from "./FixPanel.js";
import { MoveToRoom, RoomCardTap } from "./MoveTab.js";

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
 * New tab opens a tab card first, with the consent line read out (M6-06), and
 * is greyed out with the reason while the bar computer is offline. Close tab
 * then Close to the card puts the tip on the bar reader (M6-08); Move comes
 * with M6-13.
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
  /** The hold's headroom, and whether it can grow, was declined or is being checked (M6-07). */
  readonly hold: {
    readonly left_cents: number;
    readonly can_grow: boolean;
    readonly declined: boolean;
    readonly checking: boolean;
  } | null;
  readonly owner: { readonly id: string; readonly name: string | null } | null;
  readonly opened_at: string;
  readonly totals: { readonly total_cents: number } | null;
  readonly cut_off: { readonly at: string; readonly by: string | null } | null;
  readonly waiting_for: string | null;
  readonly unsent: number;
  /** A split kept on the server (M6-10), what its paid shares came to, and the rest (the next charge). */
  readonly split: Split | null;
  readonly paid_cents: number;
  readonly rest_cents: number;
  /** Reopened after its hold was captured (M6-12): "Paid $272.19 · no hold", never Close to card. */
  readonly no_hold: boolean;
  /** The card saved from the first tap (none after a wallet tap), and a charge on it waiting. */
  readonly saved_card: {
    readonly brand: string | null;
    readonly last4: string | null;
    readonly payment_id: string | null;
  } | null;
  /** Closed tonight, and can be reopened until the night closes. */
  readonly reopenable: boolean;
  /** Moved into a room (M6-13): "Moved to Room 9". */
  readonly moved_to: { readonly room: string } | null;
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
  readonly reverses_id: number | null;
  readonly alcohol?: boolean;
  /** A moved line names the other side (M6-13): "Moved from Jess P.'s bar tab", "Moved to Room 9". */
  readonly moved?: {
    readonly from_tab?: string | null;
    readonly from_room?: string | null;
    readonly to_tab?: string | null;
    readonly to_room?: string | null;
  };
}
interface MovedHold {
  readonly tab_id: string;
  readonly name: string;
  readonly cents: number;
}
type Picked = { kind: "tab"; id: string } | { kind: "room"; id: string } | { kind: "quick" } | null;

const AMBER_S = 120;
const PINK_S = 240;

export function Rail() {
  const { t, money, time } = useT();
  const { state, lock, signInWithBadge } = useSession();
  const navigate = useNavigate();
  const { now } = useClock();
  const { subscribe, connected } = useEvents();
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
  // After the alcohol window closes, the alcohol orders nobody accepted are cancelled at 4:00 AM
  // (M3-22); the room-order cards list them as "Cancelled at 4:00 AM", with no Decline (M6-14).
  const [stopped, setStopped] = useState<readonly WaitingOrder[]>([]);
  const night = useVenueTime(
    timeZone,
    signedIn?.membership.venue.day_cutover ?? "06:00",
  )?.businessDate.toString();

  const [section, setSection] = useState<PosSection>("favorites");
  const [query, setQuery] = useState("");
  const [find, setFind] = useState("");
  const [filter, setFilter] = useState<"all" | "mine" | "rooms">("all");
  const [picked, setPicked] = useState<Picked>({ kind: "quick" });
  const [newTab, setNewTab] = useState(false);
  /** Close tab (M6-08): the picked tab's close panel is open. */
  const [closingTab, setClosingTab] = useState<string | null>(null);
  const [splitting, setSplitting] = useState<string | null>(null);
  const [share, setShare] = useState<Share | null>(null);
  /** Refund from check (M4-22) for a tab closed tonight: its check (M6-12). */
  const [refunding, setRefunding] = useState<string | null>(null);
  const [movingTab, setMovingTab] = useState<string | null>(null);
  const [holds, setHolds] = useState<readonly MovedHold[]>([]);
  const [pendingFixes, setPendingFixes] = useState<readonly PendingFix[]>([]);
  /** The sent drink tapped on the tab, for Void, Comp or Move (M6-15). */
  const [fixing, setFixing] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lines, setLines] = useState<readonly CheckLine[]>([]);
  const [ringRequest, setRingRequest] = useState<{ variantId: string; n: number } | null>(null);
  // The drinks panel goes away while a tab is closed, split or refunded, and comes back fresh: the last tap
  // on the grid must not ring again when it does (M6-12).
  useEffect(() => setRingRequest(null), [closingTab, splitting, refunding, movingTab]);
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
  // `waiting` changes with every order event, so the cancelled cards follow the same reloads.
  useEffect(() => {
    if (!venueId || !windowClosed || !night) {
      setStopped([]);
      return;
    }
    let live = true;
    api<{ orders: WaitingOrder[] }>(
      "GET",
      `/v1/venues/${venueId}/orders?status=cancelled&business_date=${night}`,
    )
      .then((r) => {
        if (live) setStopped(r.orders.filter((o) => o.cancel_reason === "alcohol_closed"));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [venueId, windowClosed, night, waiting]);
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
              e.type === "draft.updated" ||
              // A decision on a comp or void over the limit ("Waiting for Andy", M6-15).
              e.type === "approval.decided",
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
  // Another tab or room starts with no drink being fixed.
  useEffect(() => setFixing(null), [checkId]);
  const loadLines = useCallback(async () => {
    if (!checkId) {
      setHolds([]);
      return setLines([]);
    }
    try {
      const v = await api<{
        lines: CheckLine[];
        holds?: MovedHold[];
        pending_fixes?: PendingFix[];
      }>("GET", `/v1/venues/${venueId}/checks/${checkId}`);
      setLines(v.lines);
      setHolds(v.holds ?? []);
      setPendingFixes(v.pending_fixes ?? []);
    } catch {
      setLines([]);
      setHolds([]);
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
    setNotice(null);
    setNewTab(false);
    setClosingTab(null);
    setSplitting(null);
    setShare(null);
    setRefunding(null);
    setMovingTab(null);
    setPicked(next);
  };
  /** Reopen (M6-12): a tab closed tonight comes back, with what was paid kept as paid. */
  const reopen = async (tabId: string) => {
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/tabs/${tabId}/reopen`);
      await load();
      pick({ kind: "tab", id: tabId });
    } catch {
      setError(t("barOrders.failed"));
    }
  };
  const canRefund = signedIn?.membership.permissions.includes("refunds.request") ?? false;
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
  // A sent drink can be fixed on an open tab nobody is closing, moving or splitting, or on a room in use.
  const fixOpen = tab
    ? tab.state === "open" &&
      closingTab !== tab.id &&
      movingTab !== tab.id &&
      !tab.split &&
      splitting !== tab.id
    : !!room?.session?.check_id;
  const drinks = lines.filter(
    (l) => !["room_time", "tax", "gratuity", "card_surcharge", "cash_discount"].includes(l.kind),
  );

  // Alcohol greys out on the grid, with the reason in words (M6-14; Rail note 9): outside the
  // alcohol window, or on a cut-off tab or room. The server refuses it anyway.
  const noAlcohol = windowClosed
    ? t("drinks.alcohol.closed")
    : tab?.cut_off
      ? t("drinks.alcohol.cutOffTab")
      : room?.session?.cut_off
        ? t("drinks.alcohol.cutOff")
        : null;
  const canCutOff = signedIn?.membership.permissions.includes("cutoff.apply") ?? false;

  const badges = (x: Tab) => [
    ...(x.cut_off ? [t("rail.badge.cutOff")] : []),
    ...(x.hold?.declined ? [t("rail.badge.holdDeclined")] : []),
    ...(x.hold && !x.hold.can_grow && !x.hold.declined
      ? [t("rail.hold.left", { amount: money(x.hold.left_cents as never) })]
      : []),
    ...(x.hold?.checking ? [t("pay.unknown")] : []),
    ...(x.waiting_for ? [t("rail.badge.waiting", { name: x.waiting_for })] : []),
    ...(x.unsent > 0 ? [t("rail.badge.unsent", { n: x.unsent })] : []),
    ...(x.open && x.no_hold
      ? [t("rail.noHold", { amount: money(x.paid_cents as never) })]
      : x.open && x.paid_cents > 0
        ? [
            t("rail.badge.partlyPaid", {
              paid: money(x.paid_cents as never),
              total: money((x.totals?.total_cents ?? 0) as never),
            }),
          ]
        : []),
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
          {stopped.map((o) => (
            <li key={o.id} className="rail-order stopped" aria-label={o.room_name ?? ""}>
              <strong>{o.room_name}</strong>{" "}
              <span className="small">{t(staffOrderWordsKey(o as never), { age: "" })}</span>
              <div className="small" data-guest-text>
                {o.items.map((i) => `${i.qty} × ${i.name_snapshot}`).join(", ")}
              </div>
            </li>
          ))}
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
            <button
              type="button"
              className="primary new-tab-button"
              disabled={!connected}
              aria-pressed={newTab}
              onClick={() => {
                setNotice(null);
                setNewTab(true);
              }}
            >
              {t("newTab.button")}
            </button>
            {!connected && (
              <p className="small muted" role="status">
                {t("newTab.offline")}
              </p>
            )}
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
                    <li key={x.id} className="small closed-tab">
                      <span className="name" data-guest-text>
                        {x.name}
                      </span>
                      <span className="amount">{money((x.totals?.total_cents ?? 0) as never)}</span>
                      {x.moved_to && (
                        <span className="small muted">
                          {t("moveTab.moved", { room: x.moved_to.room })}
                        </span>
                      )}
                      {/* Closed tonight (M6-12): Reopen, and managers refund (Refund from check). */}
                      {x.reopenable && (
                        <span className="actions">
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => void reopen(x.id)}
                          >
                            {t("rail.reopen")}
                          </button>
                          {canRefund && (
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => {
                                pick(null);
                                setRefunding(x.check_id);
                              }}
                            >
                              {t("refund.button")}
                            </button>
                          )}
                        </span>
                      )}
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
                const refused = item.alcohol && noAlcohol !== null && !eightySix;
                const out =
                  item.out_tonight || item.variants.every((v) => v.out_tonight) || refused;
                const why = refused ? noAlcohol : t("drinks.out");
                const name = item.button_name ?? item.name;
                const price = item.variants[0]?.price_cents ?? 0;
                return (
                  <li key={item.id} className={out ? "slot out" : "slot"}>
                    <button
                      type="button"
                      disabled={(out && !eightySix) || refused}
                      aria-label={out ? `${name} · ${why}` : `${name} · ${money(price as never)}`}
                      onClick={() => tapItem(item)}
                    >
                      <span data-guest-text>{name}</span>
                      <span className="small">{out ? why : money(price as never)}</span>
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
            {notice && (
              <p className="small" role="status">
                {notice}
              </p>
            )}
            {refunding ? (
              <RefundSheet
                key={refunding}
                venueId={venueId}
                checkId={refunding}
                onClose={() => {
                  setRefunding(null);
                  void load();
                }}
              />
            ) : newTab ? (
              <NewTab
                venueId={venueId}
                takenLabels={openTabs.flatMap((x) => (x.label ? [x.label] : []))}
                onClose={() => setNewTab(false)}
                onOpened={(opened, existing) => {
                  void load().then(() => {
                    pick({ kind: "tab", id: opened.id });
                    if (existing) setNotice(t("newTab.existing", { name: opened.name }));
                  });
                }}
              />
            ) : picked?.kind === "quick" ? (
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
                  {tab &&
                    (tab.no_hold ? (
                      // A reopened tab whose hold was captured (M6-12): no hold chip, what was paid.
                      <span className="chip">
                        {t("rail.noHold", { amount: money(tab.paid_cents as never) })}
                      </span>
                    ) : (
                      <span className="chip">
                        {t("rail.hold", { amount: money(tab.hold_cents as never) })}
                      </span>
                    ))}
                  {tab?.hold && !tab.hold.declined && (
                    <span className={tab.hold.can_grow ? "chip" : "chip warn"}>
                      {t("rail.hold.left", { amount: money(tab.hold.left_cents as never) })}
                    </span>
                  )}
                  {tab?.hold?.declined && (
                    <span className="chip warn">{t("rail.badge.holdDeclined")}</span>
                  )}
                  {tab?.hold?.checking && <span className="chip warn">{t("pay.unknown")}</span>}
                  {room?.session && (
                    <span className="chip">
                      {t("rail.ids", { n: room.session.ids_checked, of: room.session.party_size })}
                    </span>
                  )}
                  {/* A bar tab moved in with no card on the room yet (M6-13): its hold, with its name. */}
                  {room &&
                    holds.map((h) => (
                      <span key={h.tab_id} className="chip">
                        {t("moveTab.roomHold", { amount: money(h.cents as never), name: h.name })}
                      </span>
                    ))}
                  {room?.session?.cut_off && (
                    <span className="chip warn">{t("rail.badge.cutOff")}</span>
                  )}
                  {tab?.waiting_for && (
                    <span className="chip warn">
                      {t("rail.badge.waiting", { name: tab.waiting_for })}
                    </span>
                  )}
                </div>
                {tab && (tab.open || tab.cut_off) && (
                  <CutOffTab
                    key={`cut-${tab.id}`}
                    venueId={venueId}
                    tabId={tab.id}
                    timeZone={timeZone}
                    cutOff={tab.cut_off}
                    canCutOff={canCutOff && ["open", "tipping", "awaiting_tip"].includes(tab.state)}
                    onDone={() => void load()}
                  />
                )}
                <ul className="on-tab" aria-label={t("rail.onTab")}>
                  {drinks.map((l) => {
                    const body = (
                      <>
                        <span data-guest-text>
                          {l.qty > 1 ? `${l.qty} × ${l.description}` : l.description}
                        </span>
                        {l.moved && (
                          <span className="small muted moved">
                            {l.moved.from_tab
                              ? t("moveTab.movedFrom", { name: l.moved.from_tab })
                              : l.moved.to_room
                                ? t("moveTab.moved", { room: l.moved.to_room })
                                : l.moved.to_tab
                                  ? t("moveTab.movedToTab", { name: l.moved.to_tab })
                                  : null}
                          </span>
                        )}
                        <span>{money(l.amount_cents as never)}</span>
                      </>
                    );
                    // Over the reason-only limit the line reads "Waiting for Andy" until he decides.
                    const waiting = pendingFixes.find((p) => p.line_id === l.id);
                    return (
                      <li key={String(l.id)}>
                        {waiting ? (
                          <>
                            {body}
                            <span className="small waiting">
                              {t("fix.waiting", { name: waiting.waiting_for })}
                            </span>
                          </>
                        ) : fixOpen && isFixable(l, lines) ? (
                          // Tap a sent drink for Void, Comp or Move (spec 10 · Changing a sent drink).
                          <button
                            type="button"
                            className="tab-line"
                            aria-expanded={fixing === l.id}
                            aria-label={`${t("fix.open")} · ${l.description}`}
                            onClick={() => setFixing(fixing === l.id ? null : l.id)}
                          >
                            {body}
                          </button>
                        ) : (
                          body
                        )}
                      </li>
                    );
                  })}
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
                {tab && closingTab === tab.id ? (
                  <CloseTab
                    key={tab.id}
                    venueId={venueId}
                    tabId={tab.id}
                    checkId={tab.check_id}
                    card={tab.card ? `${tab.card.brand ?? ""} ··${tab.card.last4}`.trim() : null}
                    totalCents={tab.rest_cents}
                    resume={tab.state === "tipping"}
                    noHold={tab.no_hold}
                    savedCard={
                      tab.no_hold && tab.saved_card
                        ? {
                            card: `${tab.card?.brand ?? tab.saved_card.brand ?? ""} ··${tab.saved_card.last4 ?? ""}`.trim(),
                            paymentId: tab.saved_card.payment_id,
                          }
                        : null
                    }
                    onClose={() => {
                      setClosingTab(null);
                      void load();
                    }}
                    onChanged={() => void load()}
                  />
                ) : tab && movingTab === tab.id ? (
                  <MoveToRoom
                    venueId={venueId}
                    tabId={tab.id}
                    rooms={rooms}
                    onClose={() => setMovingTab(null)}
                    onMoved={(message, roomId) => {
                      // The room it moved into, with the moved drinks on its check.
                      pick({ kind: "room", id: roomId });
                      setNotice(message);
                      void load();
                    }}
                  />
                ) : tab && (tab.split || splitting === tab.id) && tab.state === "open" ? (
                  <>
                    {/* Split (M6-10): kept on the server, so it's here again after switching tabs. */}
                    <SplitPanel
                      venueId={venueId}
                      checkId={tab.check_id}
                      split={tab.split}
                      picked={share?.id ?? null}
                      onPick={setShare}
                      onChanged={() => void load()}
                      tab={{
                        start: (n) =>
                          api("POST", `/v1/venues/${venueId}/tabs/${tab.id}/split`, { shares: n }),
                        card:
                          tab.hold && tab.card
                            ? `${tab.card.brand ?? ""} ··${tab.card.last4}`.trim()
                            : null,
                        toCard: () => {
                          setShare(null);
                          setClosingTab(tab.id);
                        },
                      }}
                    />
                    {share && (
                      <>
                        <TapPayment
                          key={`tap-${share.id}`}
                          venueId={venueId}
                          checkId={tab.check_id}
                          dueCents={share.amount_cents}
                          shareId={share.id}
                          onDone={() => {
                            setShare(null);
                            void load();
                          }}
                        />
                        <CashPanel
                          key={`cash-${share.id}`}
                          venueId={venueId}
                          checkId={tab.check_id}
                          dueCents={share.amount_cents}
                          shareId={share.id}
                          onTaken={() => {
                            setShare(null);
                            void load();
                          }}
                        />
                      </>
                    )}
                    {!tab.split && (
                      <button type="button" className="link" onClick={() => setSplitting(null)}>
                        {t("closeTab.back")}
                      </button>
                    )}
                  </>
                ) : (
                  tab && (
                    <div className="actions">
                      <button
                        type="button"
                        className="secondary repeat"
                        onClick={() => void repeat(tab.id)}
                      >
                        {t("rail.repeat")}
                      </button>
                      {tab.state === "open" && tab.rest_cents > 0 && !tab.no_hold && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setSplitting(tab.id)}
                        >
                          {t("split.title")}
                        </button>
                      )}
                      {tab.state === "open" && !tab.split && tab.paid_cents === 0 && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setMovingTab(tab.id)}
                        >
                          {t("moveTab.button")}
                        </button>
                      )}
                      {/* A reopened tab with no hold (M6-12): pay buttons only while something is due. */}
                      {((tab.hold && (tab.state === "open" || tab.state === "tipping")) ||
                        (tab.no_hold &&
                          tab.state === "open" &&
                          (tab.rest_cents > 0 || tab.saved_card?.payment_id))) && (
                        <button
                          type="button"
                          className="primary"
                          onClick={() => setClosingTab(tab.id)}
                        >
                          {t("closeTab.title")}
                        </button>
                      )}
                    </div>
                  )
                )}
                {leftOut && (
                  <p className="small" role="status">
                    {leftOut}
                  </p>
                )}
                {/* Tap a sent drink for Void, Comp or Move (M6-13: Move onto another open tab; M6-15). */}
                {fixOpen && checkId && (
                  <FixPanel
                    key={`fix-${checkId}`}
                    venueId={venueId}
                    checkId={checkId}
                    lines={lines}
                    pending={pendingFixes}
                    pick={fixing}
                    onPick={setFixing}
                    {...(tab
                      ? {
                          moveTabs: openTabs
                            .filter((x) => x.id !== tab.id && x.state === "open")
                            .map((x) => ({ id: x.id, name: x.name, cut_off: x.cut_off })),
                        }
                      : {})}
                    onDone={() => void load()}
                  />
                )}
                {room?.session?.check_id && holds.length > 0 && (
                  <RoomCardTap
                    key={`card-${room.session.check_id}`}
                    venueId={venueId}
                    checkId={room.session.check_id}
                    room={room.name}
                    onSaved={() => void load()}
                  />
                )}
                {checkId && closingTab !== tab?.id && !tab?.split && splitting !== tab?.id && (
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
