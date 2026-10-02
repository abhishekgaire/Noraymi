import { useState } from "react";
import { cents, type MessageKey } from "@west4/shared";
import { api } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Split (M4-14; Money rules 13; screens N21): evenly in N shares, kept on
 * the server, each share with its own way to pay and state, and "Stop
 * splitting · charge the rest to …". Splitting by item is the same API; its
 * line picker comes with the close-out screen (M4-20).
 */
export interface Share {
  readonly id: string;
  readonly share_no: number;
  readonly amount_cents: number;
  readonly state: "open" | "paying" | "paid";
}
export interface Split {
  readonly id: string;
  readonly share_count: number;
  readonly shares: readonly Share[];
}

export function SplitPanel({
  venueId,
  checkId,
  split,
  picked,
  onPick,
  onChanged,
}: {
  venueId: string;
  checkId: string;
  split: Split | null;
  picked: string | null;
  onPick: (share: Share | null) => void;
  onChanged: () => void;
}) {
  const { t, money } = useT();
  const [ways, setWays] = useState("2");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await call();
      onChanged();
    } catch {
      setError(t("split.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="split" aria-label={t("split.title")}>
      <h3>{t("split.title")}</h3>
      {!split ? (
        <div className="team-actions">
          <label>
            <span>{t("split.ways")}</span>
            <input
              inputMode="numeric"
              aria-label={t("split.ways")}
              value={ways}
              onChange={(e) => setWays(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy || !(Number(ways) >= 2)}
            onClick={() =>
              void act(() =>
                api("POST", `/v1/venues/${venueId}/checks/${checkId}/splits`, {
                  kind: "even",
                  shares: Number(ways),
                }),
              )
            }
          >
            {t("split.even")}
          </button>
        </div>
      ) : (
        <>
          <ul className="list">
            {split.shares.map((s) => (
              <li
                key={s.id}
                aria-label={t("split.share", { n: s.share_no, count: split.share_count })}
              >
                <span>
                  {t("split.share", { n: s.share_no, count: split.share_count })} ·{" "}
                  {money(cents(s.amount_cents))}
                </span>
                <span className={s.state === "paid" ? "ok" : "muted"}>
                  {t(`split.state.${s.state}` as MessageKey)}
                </span>
                {s.state === "open" && (
                  <button
                    type="button"
                    className={picked === s.id ? "primary" : "secondary"}
                    onClick={() => onPick(picked === s.id ? null : s)}
                  >
                    {t("split.pay")}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                onPick(null);
                await api("POST", `/v1/venues/${venueId}/splits/${split.id}/stop`);
              })
            }
          >
            {t("split.stop")}
          </button>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
