import { useEffect, useRef, useState, type FormEvent } from "react";
import { deviceOnlyApi, readDevice } from "../device.js";
import { useT } from "../i18n.js";
import { newOrderId, useQueue, type QueuedRound } from "../queue.js";

/**
 * Queue mode on the bar POS (M8-04; spec 09 · Offline and queue mode; Rail
 * note 17). Offline, a manager's code opens it on this computer; then a
 * round on an open tab is queued here, with the name of whoever rang it
 * picked from the kept team (no PIN offline: no device keeps PIN hashes),
 * and shows "queued · not charged" until the replay (M8-05).
 */

/** The offline code form, shown under the pink banner until queue mode opens. */
export function OfflineCodeForm() {
  const { t } = useT();
  const queue = useQueue();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await queue.unlock(code);
      if (r === "ok") setCode("");
      else
        setError(
          r === "used"
            ? t("queue.code.used")
            : r === "not_set_up"
              ? t("queue.code.notSetUp")
              : t("queue.code.wrong"),
        );
    } catch {
      setError(t("queue.code.wrong"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="queue-code" data-view onSubmit={(e) => void submit(e)}>
      <label>
        {t("queue.code.label")}
        <input
          inputMode="numeric"
          autoComplete="off"
          maxLength={12}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </label>
      <button type="submit" className="primary" disabled={busy || code.trim().length < 6}>
        {t("queue.code.open")}
      </button>
      <p className="small muted">{t("queue.code.hint")}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** "1 × Jäger Bomb · queued · not charged · Maya S.": each round queued on this tab, until it replays. */
export function QueuedRounds({ tabId }: { tabId: string }) {
  const { t } = useT();
  const rounds = useQueue().rounds.filter((r) => r.tab_id === tabId);
  if (rounds.length === 0) return null;
  return (
    <ul className="queued-rounds" aria-label={t("queue.list")}>
      {rounds.map((r) => (
        <li key={r.order_id} className="queued">
          {t("queue.queuedBy", { lines: linesText(r), name: r.staff.name })}
        </li>
      ))}
    </ul>
  );
}

function linesText(r: QueuedRound): string {
  return r.lines.map((l) => `${l.qty} × ${l.name}`).join(", ");
}

interface Tile {
  readonly membership_id: string;
  readonly name: string;
}

export interface QueueLineSource {
  readonly variant_id: string;
  readonly name: string;
  readonly unit_cents: number;
  readonly alcohol: boolean;
}

/** The round being queued on the picked tab: the drinks tapped on the grid, who rang it, and an optional cash note. */
export function QueuePanel({
  venueId,
  tab,
  ringRequest,
  lookup,
}: {
  venueId: string;
  tab: { readonly id: string; readonly check_id: string; readonly name: string };
  ringRequest: { variantId: string; n: number } | null;
  lookup: (variantId: string) => QueueLineSource | null;
}) {
  const { t } = useT();
  const queue = useQueue();
  const [lines, setLines] = useState<readonly (QueueLineSource & { qty: number })[]>([]);
  const [team, setTeam] = useState<readonly Tile[]>([]);
  const [who, setWho] = useState("");
  const [cash, setCash] = useState("");
  const [error, setError] = useState<string | null>(null);
  const seen = useRef(ringRequest?.n ?? 0);

  // The kept team: names and roles from the last sync, no PINs.
  useEffect(() => {
    let live = true;
    void (async () => {
      const device = await readDevice();
      if (!device) return;
      const answer = await deviceOnlyApi<{ tiles: Tile[] }>(
        device,
        "GET",
        `/v1/venues/${venueId}/team/tiles`,
      ).catch(() => null);
      if (live && answer) setTeam(answer.tiles);
    })();
    return () => {
      live = false;
    };
  }, [venueId]);

  // A tap on the grid adds the drink.
  useEffect(() => {
    if (!ringRequest || ringRequest.n === seen.current) return;
    seen.current = ringRequest.n;
    const found = lookup(ringRequest.variantId);
    if (!found) return;
    setLines((ls) => {
      const i = ls.findIndex((l) => l.variant_id === found.variant_id);
      if (i < 0) return [...ls, { ...found, qty: 1 }];
      return ls.map((l, j) => (j === i ? { ...l, qty: Math.min(99, l.qty + 1) } : l));
    });
  }, [ringRequest, lookup]);

  const person = team.find((p) => p.membership_id === who);
  const send = async () => {
    if (!person || lines.length === 0) return;
    setError(null);
    try {
      await queue.add({
        order_id: newOrderId(),
        tab_id: tab.id,
        check_id: tab.check_id,
        tab_name: tab.name,
        staff: { membership_id: person.membership_id, name: person.name },
        lines: lines.map((l) => ({
          variant_id: l.variant_id,
          name: l.name,
          qty: l.qty,
          unit_cents: l.unit_cents,
          alcohol: l.alcohol,
        })),
        cash_note: cash.trim() ? cash.trim() : null,
      });
      setLines([]);
      setCash("");
    } catch {
      setError(t("queue.round.failed"));
    }
  };

  return (
    <div className="queue-panel" data-queue>
      <h3>{t("queue.round.title", { name: tab.name })}</h3>
      {lines.length === 0 ? (
        <p className="small muted">{t("queue.round.empty")}</p>
      ) : (
        <ul className="queue-lines">
          {lines.map((l) => (
            <li key={l.variant_id}>
              <span data-guest-text>
                {l.qty} × {l.name}
              </span>{" "}
              <button
                type="button"
                className="link"
                aria-label={t("queue.round.remove", { name: l.name })}
                onClick={() => setLines((ls) => ls.filter((x) => x.variant_id !== l.variant_id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <label>
        {t("queue.round.who")}
        <select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">{t("queue.round.pickWho")}</option>
          {team.map((p) => (
            <option key={p.membership_id} value={p.membership_id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("queue.round.cash")}
        <input value={cash} maxLength={200} onChange={(e) => setCash(e.target.value)} />
      </label>
      <p className="small muted">{t("queue.round.cashHint")}</p>
      <button
        type="button"
        className="primary"
        disabled={!person || lines.length === 0}
        onClick={() => void send()}
      >
        {t("queue.round.send")}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
