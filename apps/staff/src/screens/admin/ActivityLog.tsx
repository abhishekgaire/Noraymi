import { useCallback, useEffect, useState } from "react";
import type { MessageKey } from "@west4/shared";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Activity log (P-14; spec 12 · 4): the venue's own audit rows, newest first, 50 at a time,
 * filtered by person, kind and business date. The owner's (managers come with P-10). The API masks
 * phone numbers, emails and guests' names and never sends a secret's value; this screen only shows
 * what it's given, and a withheld value reads "hidden".
 */
interface Change {
  readonly field: string;
  readonly hidden: boolean;
  readonly old: unknown;
  readonly new: unknown;
}
interface Row {
  readonly id: string;
  readonly at: string;
  readonly business_date: string;
  readonly actor: { readonly user_id: string; readonly name: string | null } | null;
  readonly support: boolean;
  readonly kind: string;
  readonly op: string;
  readonly record_id: string;
  readonly changes: readonly Change[];
}
interface Answer {
  readonly rows: readonly Row[];
  readonly next_before: string | null;
  readonly people: readonly { user_id: string; name: string }[];
  readonly kinds: readonly string[];
}
interface Filters {
  readonly person: string;
  readonly kind: string;
  readonly from: string;
  readonly to: string;
}
const NONE: Filters = { person: "", kind: "", from: "", to: "" };
const SHOWN = 4;

const query = (f: Filters, before: string | null) => {
  const q = new URLSearchParams();
  if (f.person) q.set("person", f.person);
  if (f.kind) q.set("kind", f.kind);
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (before) q.set("before", before);
  const s = q.toString();
  return s ? `?${s}` : "";
};

const short = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
};

export function ActivityLog() {
  const { t, time, date } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const timeZone = state.status === "signedIn" ? state.membership.venue.time_zone : "UTC";
  const [filters, setFilters] = useState<Filters>(NONE);
  const [rows, setRows] = useState<readonly Row[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [people, setPeople] = useState<Answer["people"]>([]);
  const [kinds, setKinds] = useState<readonly string[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (before: string | null) => {
      if (!venueId) return;
      setBusy(true);
      try {
        const r = await api<Answer>(
          "GET",
          `/v1/venues/${venueId}/activity${query(filters, before)}`,
        );
        setRows((old) => (before && old ? [...old, ...r.rows] : r.rows));
        setNext(r.next_before);
        setPeople(r.people);
        if (!before) setKinds(r.kinds);
        setFailed(false);
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
    [venueId, filters],
  );
  useEffect(() => {
    setRows(null);
    void load(null);
  }, [load]);

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const who = (r: Row) =>
    r.support
      ? t("activity.by.support")
      : r.actor === null
        ? t("activity.by.system")
        : (r.actor.name ?? t("activity.by.unknown"));
  const opText = (op: string) =>
    ["insert", "update", "delete"].includes(op) ? t(`activity.op.${op}` as MessageKey) : op;
  const value = (c: Change, v: unknown) => (c.hidden ? t("activity.hidden") : short(v));
  const change = (c: Change, r: Row) => (
    <li key={c.field}>
      <code>{c.field}</code>{" "}
      {r.op === "update"
        ? `${value(c, c.old)} → ${value(c, c.new)}`
        : value(c, r.op === "delete" ? c.old : c.new)}
    </li>
  );

  return (
    <section className="activity-log" aria-labelledby="activity-h">
      <h2 id="activity-h">{t("admin.section.activity")}</h2>
      <p className="small">{t("activity.intro")}</p>
      <fieldset className="activity-filters">
        <legend>{t("activity.filters")}</legend>
        <label>
          {t("activity.filter.person")}
          <select value={filters.person} onChange={(e) => set({ person: e.target.value })}>
            <option value="">{t("activity.filter.everyone")}</option>
            <option value="system">{t("activity.filter.system")}</option>
            {people.map((p) => (
              <option key={p.user_id} value={p.user_id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("activity.filter.kind")}
          <select value={filters.kind} onChange={(e) => set({ kind: e.target.value })}>
            <option value="">{t("activity.filter.allKinds")}</option>
            {[...new Set([...kinds, ...(filters.kind ? [filters.kind] : [])])].map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("activity.filter.from")}
          <input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label>
          {t("activity.filter.to")}
          <input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={filters === NONE}
          onClick={() => setFilters(NONE)}
        >
          {t("activity.filter.clear")}
        </button>
      </fieldset>
      {failed && (
        <p className="error" role="alert">
          {t("activity.cantLoad")}{" "}
          <button type="button" className="secondary" onClick={() => void load(null)}>
            {t("shell.error.retry")}
          </button>
        </p>
      )}
      {rows === null ? (
        !failed && <p role="status">{t("activity.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="hint">{t("activity.empty")}</p>
      ) : (
        <ol className="activity-rows" aria-label={t("admin.section.activity")}>
          {rows.map((r) => (
            <li key={r.id} className="activity-row">
              <div className="activity-head">
                <span className="activity-when">
                  {date(r.business_date)} · {time(r.at, timeZone)}
                </span>
                <strong className="activity-who">{who(r)}</strong>
                <span className="activity-what">
                  {opText(r.op)} · <code>{r.kind}</code>{" "}
                  <span className="muted">{r.record_id.slice(0, 8)}</span>
                </span>
              </div>
              {r.changes.length > 0 && (
                <ul className="activity-changes" aria-label={t("activity.col.changes")}>
                  {r.changes.slice(0, SHOWN).map((c) => change(c, r))}
                </ul>
              )}
              {r.changes.length > SHOWN && (
                <details className="activity-more">
                  <summary>
                    {t("activity.moreChanges", { count: r.changes.length - SHOWN })}
                  </summary>
                  <ul className="activity-changes">
                    {r.changes.slice(SHOWN).map((c) => change(c, r))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
      {next && (
        <button
          type="button"
          className="secondary activity-older"
          disabled={busy}
          onClick={() => void load(next)}
        >
          {t("activity.more")}
        </button>
      )}
    </section>
  );
}
