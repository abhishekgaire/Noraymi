import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiCallError } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";
import { uploadPhoto } from "../upload.js";
import { dollarsToCents } from "./admin/Prices.js";

/**
 * N26 Tips to enter (M6-09; Payment flows · Bar tab with a growing hold, step
 * 5; glossary · Tips to enter): the staff phone's list of signed paper slips
 * waiting for a tip, each with its card, total, when it printed and the photo
 * of the slip. Tapping one takes (or keeps) the photo and the tip written on
 * the slip; Enter tip captures the total plus the tip on the held card, or,
 * for a tip over 25% or $50 or typed in more than 2 hours late, sends it to
 * the manager on duty ("Sent to Andy C. to approve"). No photo, no tip.
 */
interface Slip {
  readonly id: string;
  readonly name: string;
  readonly card: { readonly brand: string; readonly last4: string } | null;
  readonly waiting_for: string | null;
  readonly slip: {
    readonly total_cents: number;
    readonly printed_at: string | null;
    readonly photo_file_id: string | null;
    readonly waiting_for: string | null;
  } | null;
}
interface Entered {
  readonly state: string;
  readonly payment?: { readonly unknown: boolean };
  readonly capture_cents: number | null;
  readonly tip_cents: number | null;
}

function SlipPhoto({ venueId, fileId, alt }: { venueId: string; fileId: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let live = true;
    void api<{ url: string }>("GET", `/v1/venues/${venueId}/files/${fileId}`)
      .then((r) => live && setUrl(r.url))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [venueId, fileId]);
  if (!url || broken) return null;
  return <img className="slip-photo" src={url} alt={alt} onError={() => setBroken(true)} />;
}

export function TipsToEnter() {
  const { t, money, time } = useT();
  const { state } = useSession();
  const { subscribe } = useEvents();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const [slips, setSlips] = useState<readonly Slip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const r = await api<{ tabs: Slip[] }>("GET", `/v1/venues/${venueId}/tabs?state=awaiting_tip`);
      setSlips(r.tabs);
      setError(null);
    } catch {
      setError(t("tips.failed"));
    }
  }, [venueId, t]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (
          events.length === 0 ||
          events.some((e) => e.type.startsWith("tab.") || e.type.startsWith("approval."))
        )
          void load();
      }),
    [subscribe, load],
  );

  const pick = (id: string | null) => {
    setOpen(id);
    setPhoto(null);
    setAmount("");
    setProblem(null);
  };
  const slip = slips?.find((s) => s.id === open) ?? null;
  const tipCents = dollarsToCents(amount);
  const hasPhoto = photo !== null || Boolean(slip?.slip?.photo_file_id);
  const preview = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const enter = async (e: FormEvent) => {
    e.preventDefault();
    if (!slip || tipCents === null) return;
    if (!hasPhoto) {
      setProblem(t("tips.photoRequired"));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const photoId = photo ? await uploadPhoto(venueId, "slip_photo", photo) : null;
      const key = `tip-${slip.id}-${Date.now()}`;
      const r = await api<Entered & { status?: string; waiting_for?: { name: string } }>(
        "POST",
        `/v1/venues/${venueId}/tabs/${slip.id}/tip`,
        { tip_cents: tipCents, ...(photoId ? { photo_file_id: photoId } : {}) },
        { idempotencyKey: key },
      );
      const said = (c: Entered) =>
        c.state === "captured"
          ? t("closeTab.paid", {
              amount: money((c.capture_cents ?? 0) as never),
              tip: money((c.tip_cents ?? 0) as never),
            })
          : c.state === "failed"
            ? t("closeTab.failed")
            : c.payment?.unknown
              ? t("pay.unknown")
              : t("closeTab.charging");
      setDone(
        r.status === "approval_pending" && r.waiting_for
          ? t("tips.sentTo", { name: r.waiting_for.name })
          : said(r),
      );
      const tabId = slip.id;
      pick(null);
      // The capture may still be with Stripe: read it each second until it's settled, as Close tab does.
      if (r.status !== "approval_pending" && (r.state === "capturing" || r.state === "raising"))
        void (async () => {
          for (let i = 0; i < 30; i++) {
            await new Promise((ok) => setTimeout(ok, 1000));
            const c = await api<Entered>(
              "POST",
              `/v1/venues/${venueId}/tabs/${tabId}/close/check-status`,
            ).catch(() => null);
            if (!c) continue;
            setDone(said(c));
            if (c.state !== "capturing" && c.state !== "raising") break;
          }
          void load();
        })();
      await load();
    } catch (err) {
      const reason = (err instanceof ApiCallError ? err.details : undefined) as
        { reason?: string } | undefined;
      setProblem(reason?.reason === "photo_required" ? t("tips.photoRequired") : t("tips.error"));
    } finally {
      setBusy(false);
    }
  };

  if (slips === null && !error)
    return (
      <section className="screen">
        <p role="status">{t("shell.loading")}</p>
      </section>
    );

  return (
    <section className="screen tips-to-enter" aria-labelledby="tips-title">
      <h1 id="tips-title">{t("tips.title")}</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="notice">
          {done}
        </p>
      )}
      {slip ? (
        <form className="card tip-entry" onSubmit={(e) => void enter(e)}>
          <div className="row">
            <strong data-guest-text>{slip.name}</strong>
            <span>{money((slip.slip?.total_cents ?? 0) as never)}</span>
          </div>
          {slip.card && (
            <p className="small" data-guest-text>
              {`${slip.card.brand} ··${slip.card.last4}`}
            </p>
          )}
          {preview ? (
            <img className="slip-photo" src={preview} alt={t("tips.photoOf")} />
          ) : slip.slip?.photo_file_id ? (
            <SlipPhoto venueId={venueId} fileId={slip.slip.photo_file_id} alt={t("tips.photoOf")} />
          ) : null}
          <label className="photo-pick">
            {hasPhoto ? t("tips.retake") : t("tips.takePhoto")}
            <input
              type="file"
              accept="image/jpeg,image/png,image/heic"
              capture="environment"
              onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
            />
          </label>
          <label>
            {t("tips.amount")}
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoComplete="off"
            />
          </label>
          {problem && (
            <p role="alert" className="error">
              {problem}
            </p>
          )}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy || tipCents === null}>
              {t("tips.enter")}
            </button>
            <button type="button" className="link" onClick={() => pick(null)}>
              {t("tips.back")}
            </button>
          </div>
        </form>
      ) : (
        <>
          {slips?.length === 0 && <p className="muted">{t("tips.none")}</p>}
          <ul className="cards">
            {slips?.map((s) => (
              <li key={s.id} className="card">
                <button
                  type="button"
                  className="slip-row"
                  disabled={s.waiting_for !== null}
                  onClick={() => {
                    setDone(null);
                    pick(s.id);
                  }}
                >
                  <span className="row">
                    <strong data-guest-text>{s.name}</strong>
                    <span className="amount">{money((s.slip?.total_cents ?? 0) as never)}</span>
                  </span>
                  {s.card && (
                    <span className="small" data-guest-text>
                      {`${s.card.brand} ··${s.card.last4}`}
                    </span>
                  )}
                  <span className="small">
                    {s.slip?.printed_at
                      ? t("tips.signed", { time: time(s.slip.printed_at, timeZone) })
                      : null}
                    {" · "}
                    {s.slip?.photo_file_id ? t("tips.photoSaved") : t("tips.noPhoto")}
                  </span>
                  {s.waiting_for && (
                    <span className="badge-text">
                      {t("rail.badge.waiting", { name: s.waiting_for })}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
