import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Temporal, type MessageKey } from "@west4/shared";
import { api, ApiCallError, NetworkError } from "../api.js";
import { unreachableStatus } from "../connection-state.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { kindKey } from "../approvals/types.js";
import {
  bellItems,
  bellShown,
  readBellCache,
  unreadCount,
  writeBellCache,
  type BellItem,
  type BellKind,
  type BellRoomLine,
  type BellSources,
} from "./bell-items.js";

/** Which lists this person may see, as the menu and its badges decide (P-11). */
export interface BellReach {
  readonly approvals: boolean;
  readonly rooms: boolean;
  readonly orders: boolean;
  readonly texts: boolean;
  readonly print: boolean;
}

interface BellState {
  readonly items: readonly BellItem[] | null;
  readonly read: ReadonlySet<string>;
  /** The list is the kept one, as of this instant: the API didn't answer. */
  readonly offlineAt: string | null;
  readonly failed: boolean;
}

/** A refetch after a burst of events waits this long, so a busy night isn't a storm of reads. */
const SETTLE_MS = 1_500;
/** And it looks again this often, for what changes without an event (a ticket that didn't print). */
const REFRESH_MS = 30_000;

const unreachable = (e: unknown) =>
  e instanceof NetworkError || (e instanceof ApiCallError && unreachableStatus(e.status));

export function useBell(venueId: string, userId: string, reach: BellReach) {
  const { subscribe } = useEvents();
  const [state, setState] = useState<BellState>(() => {
    const kept = readBellCache(venueId, userId);
    return {
      items: null,
      read: new Set([...(kept?.read ?? []), ...(kept?.pending ?? [])]),
      offlineAt: null,
      failed: false,
    };
  });
  const pending = useRef<Set<string>>(new Set(readBellCache(venueId, userId)?.pending ?? []));
  const { approvals, rooms, orders, texts, print } = reach;

  const keep = useCallback(
    (items: readonly BellItem[], read: ReadonlySet<string>, at: string) => {
      const shown = new Set(items.map((i) => i.key));
      writeBellCache(venueId, userId, {
        items,
        read: [...read].filter((k) => shown.has(k)),
        pending: [...pending.current],
        at,
      });
    },
    [venueId, userId],
  );

  const flush = useCallback(async () => {
    const keys = [...pending.current].slice(0, 200);
    if (keys.length === 0) return;
    try {
      await api("POST", `/v1/venues/${venueId}/bell/reads`, { keys });
      for (const k of keys) pending.current.delete(k);
    } catch {
      // Still offline: they stay pending, and the bell already shows them read.
    }
  }, [venueId]);

  const load = useCallback(async () => {
    const base = `/v1/venues/${venueId}`;
    const none = Promise.resolve(undefined);
    const results = await Promise.allSettled([
      api<{ keys: string[] }>("GET", `${base}/bell/reads`),
      approvals
        ? api<{ waiting_for_me: BellSources["approvals"] }>(
            "GET",
            `${base}/approvals?status=pending`,
          )
        : none,
      // The bell's own light read of the rooms (U-18), never the whole board.
      rooms ? api<{ alerts: readonly BellRoomLine[] }>("GET", `${base}/bell/alerts`) : none,
      orders
        ? api<{ orders: BellSources["orders"] }>("GET", `${base}/orders?status=ringing,held`)
        : none,
      texts
        ? api<{ conversations: BellSources["conversations"] }>("GET", `${base}/conversations`)
        : none,
      print
        ? api<{ jobs: BellSources["failed"] }>("GET", `${base}/print-jobs?status=failed`)
        : none,
    ]);
    const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
    // The API didn't answer at all: the kept list, as of when it was live.
    if (errors.length > 0 && errors.every(unreachable)) {
      const kept = readBellCache(venueId, userId);
      setState((s) => ({
        items: kept?.items ?? s.items ?? [],
        read: new Set([...s.read, ...(kept?.read ?? []), ...pending.current]),
        offlineAt: kept?.at ?? null,
        failed: !kept && s.items === null,
      }));
      return;
    }
    const value = <T,>(i: number) =>
      results[i]!.status === "fulfilled"
        ? (results[i] as PromiseFulfilledResult<T>).value
        : undefined;
    const items = bellItems({
      approvals: value<{ waiting_for_me: BellSources["approvals"] }>(1)?.waiting_for_me ?? [],
      alerts: value<{ alerts: readonly BellRoomLine[] }>(2)?.alerts ?? [],
      orders: value<{ orders: BellSources["orders"] }>(3)?.orders ?? [],
      conversations: value<{ conversations: BellSources["conversations"] }>(4)?.conversations ?? [],
      failed: value<{ jobs: BellSources["failed"] }>(5)?.jobs ?? [],
    });
    const reads = value<{ keys: string[] }>(0)?.keys ?? [];
    await flush();
    const read = new Set([...reads, ...pending.current]);
    setState((s) => {
      // Reads made here since the answer left keep counting.
      const merged = new Set([...read, ...s.read]);
      keep(items, merged, Temporal.Now.instant().toString());
      return { items, read: merged, offlineAt: null, failed: errors.length > 0 };
    });
  }, [venueId, userId, approvals, rooms, orders, texts, print, flush, keep]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | null = null;
    const off = subscribe(() => {
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => void load(), SETTLE_MS);
    });
    return () => {
      off();
      if (settle) clearTimeout(settle);
    };
  }, [subscribe, load]);

  const markRead = useCallback(
    (keys: readonly string[]) => {
      if (keys.length === 0) return;
      for (const k of keys) pending.current.add(k);
      setState((s) => {
        const read = new Set([...s.read, ...keys]);
        keep(s.items ?? [], read, s.offlineAt ?? Temporal.Now.instant().toString());
        return { ...s, read };
      });
      void flush();
    },
    [flush, keep],
  );

  return { ...state, markRead, retry: load };
}

const KIND_LABEL: Readonly<Record<BellKind, MessageKey>> = {
  approval: "bell.kind.approval",
  room: "bell.kind.room",
  order: "bell.kind.order",
  text: "bell.kind.text",
  print: "bell.kind.print",
};

/**
 * The bell in the top bar and its list (P-11; U-18). It shows only what the screen in front of you
 * doesn't (no room lines on the board, no orders on Bar orders), and its number counts those.
 */
export function Bell({
  venueId,
  userId,
  timeZone,
  reach,
}: {
  venueId: string;
  userId: string;
  timeZone: string;
  reach: BellReach;
}) {
  const { t, tn, time } = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const bell = useBell(venueId, userId, reach);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionFailed, setActionFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  useEffect(() => setActionFailed(false), [open]);

  const words = (item: BellItem) =>
    item.kind === "approval"
      ? t(item.labelKey, { ...item.params, kind: t(kindKey(String(item.params["kind"]))) })
      : t(item.labelKey, item.params);
  const shown = useMemo(
    () => (bell.items ? bellShown(bell.items, pathname) : null),
    [bell.items, pathname],
  );
  const count = shown ? unreadCount(shown, bell.read) : 0;
  const unread = useMemo(
    () => (shown ?? []).filter((i) => !bell.read.has(i.key)).map((i) => i.key),
    [shown, bell.read],
  );

  const openItem = (item: BellItem) => {
    bell.markRead([item.key]);
    setOpen(false);
    void navigate(item.path);
  };
  /** On it or Accept, through the screen's own route; the server still checks everything. */
  const act = async (item: BellItem) => {
    const a = item.action;
    if (!a) return;
    setBusy(item.key);
    setActionFailed(false);
    try {
      await api(
        "POST",
        a.kind === "onIt"
          ? `/v1/venues/${venueId}/calls/${a.callId}/ack`
          : `/v1/venues/${venueId}/orders/${a.orderId}/accept`,
        a.kind === "onIt" ? undefined : {},
      );
      bell.markRead([item.key]);
      await bell.retry();
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bell" ref={root}>
      <button
        type="button"
        className="icon-button bell-button"
        aria-label={tn("bell.open", count)}
        aria-expanded={open}
        aria-controls="bell-panel"
        data-testid="bell"
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">🔔</span>
        {count > 0 && (
          <span className="badge bell-count" aria-hidden="true">
            {count}
          </span>
        )}
      </button>
      {open && (
        <section id="bell-panel" className="bell-panel" aria-label={t("bell.title")}>
          <header className="bell-head">
            <h2>{t("bell.title")}</h2>
            <button
              type="button"
              className="secondary"
              disabled={unread.length === 0}
              onClick={() => bell.markRead(unread)}
            >
              {t("bell.markAllRead")}
            </button>
          </header>
          {bell.offlineAt && (
            <p className="muted small" role="status">
              {t("bell.offline", { time: time(bell.offlineAt, timeZone) })}
            </p>
          )}
          {bell.failed && (
            <p className="error small" role="alert">
              {t("bell.failed")}{" "}
              <button type="button" className="secondary" onClick={() => void bell.retry()}>
                {t("shell.error.retry")}
              </button>
            </p>
          )}
          {actionFailed && (
            <p className="error small" role="alert">
              {t("bell.action.failed")}
            </p>
          )}
          {shown === null ? (
            !bell.failed && <p role="status">{t("shell.loading")}</p>
          ) : shown.length === 0 ? (
            <p className="muted" role="status">
              {t("bell.empty")}
            </p>
          ) : (
            <ul className="bell-list">
              {shown.map((item) => {
                const isRead = bell.read.has(item.key);
                return (
                  <li
                    key={item.key}
                    className={item.action ? "bell-line with-action" : "bell-line"}
                  >
                    <button
                      type="button"
                      className={isRead ? "bell-item" : "bell-item unread"}
                      onClick={() => openItem(item)}
                    >
                      <span className="muted small">
                        {t(KIND_LABEL[item.kind])}
                        {!isRead && ` · ${t("bell.new")}`}
                      </span>
                      <span>{words(item)}</span>
                    </button>
                    {item.action && (
                      <button
                        type="button"
                        className="primary bell-action"
                        // Offline the kept list can't act: open the line instead once it answers.
                        disabled={busy !== null || bell.offlineAt !== null}
                        aria-label={`${t(
                          item.action.kind === "onIt" ? "calls.onIt" : "bell.action.accept",
                        )} · ${words(item)}`}
                        onClick={() => void act(item)}
                      >
                        {t(item.action.kind === "onIt" ? "calls.onIt" : "bell.action.accept")}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
