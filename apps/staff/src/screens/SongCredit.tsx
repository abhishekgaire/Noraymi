import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useT } from "../i18n.js";

/**
 * "Buy a drink, get a song" on a quick sale (M6-18, the M6-05 line; Song systems and texts · Credits):
 * once a walk-up sale is paid, the bartender taps the singer who bought it and the sale's drinks earn
 * that singer their song credits. Shown only in bar mode with the drink credit on; drinks on a tab
 * earn theirs by themselves.
 */
interface Singer {
  readonly id: string;
  readonly display_name: string;
  readonly confirmed: boolean;
}

export function SongCredit({ venueId, checkId }: { venueId: string; checkId: string }) {
  const { t } = useT();
  const [singers, setSingers] = useState<readonly Singer[] | null>(null);
  const [given, setGiven] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    setGiven(null);
    api<{ drink_credit: boolean; singers: Singer[] }>("GET", `/v1/venues/${venueId}/song-queue`)
      .then((q) => {
        if (live) setSingers(q.drink_credit ? q.singers.filter((s) => s.confirmed) : null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [venueId, checkId]);

  if (!singers) return null;
  const pick = async (s: Singer) => {
    setBusy(true);
    setError(false);
    try {
      await api(
        "POST",
        `/v1/venues/${venueId}/singers/${s.id}/credits`,
        { check_id: checkId },
        { idempotencyKey: `song-credit-${checkId}-${s.id}` },
      );
      setGiven(s.display_name);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="song-credit" aria-label={t("songCredit.pick")}>
      {given ? (
        <p role="status">
          {t("songCredit.pick")} <strong data-guest-text>{given}</strong>
        </p>
      ) : (
        <>
          <h4>{t("songCredit.pick")}</h4>
          {singers.length === 0 ? (
            <p className="small muted">{t("songCredit.noSingers")}</p>
          ) : (
            <div className="chips">
              {singers.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="secondary"
                  disabled={busy}
                  data-guest-text
                  onClick={() => void pick(s)}
                >
                  {s.display_name}
                </button>
              ))}
            </div>
          )}
          {error && (
            <p className="error" role="alert">
              {t("songCredit.failed")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
