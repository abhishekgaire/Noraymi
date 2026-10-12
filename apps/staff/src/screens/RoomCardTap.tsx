import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiCallError } from "../api.js";
import { useT } from "../i18n.js";
import { useSheetDialog } from "../layout/Dialog.js";

/**
 * Card on the tab at a walk-in check-in (D112; screens N10 step 5): once the
 * party is seated, the consent line is read to the guest and they tap a card
 * on the front-desk reader. The server saves it on the room's check through
 * the reader (M6-13's card tapped for a room: a SetupIntent, nothing charged,
 * driven by the server outside any transaction, with an idempotency key).
 * The guest pays at close-out as usual. A decline, a missing or offline reader
 * leaves the party seated: tap again, or skip the card.
 */
interface Consent {
  readonly version_id: string;
  readonly text: string;
}
interface Tap {
  readonly id: string;
  readonly state: "waiting" | "saved" | "failed" | "canceled";
  readonly card: { readonly brand: string | null; readonly last4: string } | null;
}
interface Reader {
  readonly id: string;
  readonly registered: boolean;
  readonly online: boolean;
  readonly station: "bar" | "front_desk";
}
type Problem = "noReader" | "readerOffline" | "failed" | "cantReach" | null;

/** How long a tap may wait before the screen says Stripe is being checked (payments' 20 s). */
const UNKNOWN_AFTER_MS = 20_000;
const newKey = () => `room-card-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function RoomCardTap({
  venueId,
  checkId,
  roomName,
  seatedLine,
  onDone,
}: {
  venueId: string;
  checkId: string;
  roomName: string;
  /** The check-in's own line ("Room 11 · room code … · check #…"), shown above and kept. */
  seatedLine: string;
  onDone: (line: string) => void;
}) {
  const { t } = useT();
  const title = t("checkIn.card.title", { room: roomName });
  const dlg = useSheetDialog(title);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [tap, setTap] = useState<Tap | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(0);

  useEffect(() => {
    api<Consent>("GET", `/v1/venues/${venueId}/room-card-consent`)
      .then(setConsent)
      .catch(() => setProblem("cantReach"));
  }, [venueId]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const settled = useCallback(
    (row: Tap) => {
      if (row.state === "saved" && row.card)
        onDone(
          `${seatedLine} · ${t("checkIn.card.saved", {
            brand: row.card.brand ?? "",
            last4: row.card.last4,
          })}`,
        );
      else if (row.state === "failed") setProblem("failed");
    },
    [onDone, seatedLine, t],
  );

  const poll = useCallback(() => {
    timer.current = setTimeout(() => {
      api<Tap>("POST", `/v1/venues/${venueId}/checks/${checkId}/card-tap/check-status`)
        .then((row) => {
          setTap(row);
          if (row.state === "waiting") {
            setSlow(Date.now() - started.current > UNKNOWN_AFTER_MS);
            poll();
          } else settled(row);
        })
        // Not reached this second: ask again; the server settles the tap either way.
        .catch(() => poll());
    }, 1000);
  }, [venueId, checkId, settled]);

  // Read to guest ✓: the consent is recorded and the front-desk reader goes to work.
  const read = async () => {
    if (!consent) return;
    setBusy(true);
    setProblem(null);
    setSlow(false);
    try {
      const readers = await api<{ readers: Reader[] }>("GET", `/v1/venues/${venueId}/readers`);
      const reader = readers.readers
        .filter((r) => r.registered)
        .sort(
          (a, b) =>
            Number(b.station === "front_desk") - Number(a.station === "front_desk") ||
            Number(b.online) - Number(a.online),
        )[0];
      if (!reader) {
        setProblem("noReader");
        return;
      }
      const row = await api<Tap>(
        "POST",
        `/v1/venues/${venueId}/checks/${checkId}/card-tap`,
        { reader_id: reader.id, consent_text_version: consent.version_id },
        { idempotencyKey: newKey() },
      );
      setTap(row);
      started.current = Date.now();
      if (row.state === "waiting") poll();
      else settled(row);
    } catch (e) {
      setProblem(
        e instanceof ApiCallError && e.code === "reader_offline" ? "readerOffline" : "failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      const row = await api<Tap>("POST", `/v1/venues/${venueId}/checks/${checkId}/card-tap/cancel`);
      setTap(row);
      if (row.state === "saved") settled(row);
    } catch {
      setProblem("cantReach");
    }
  };

  const waiting = tap?.state === "waiting";
  return (
    <div className="sheet room-card-tap" {...dlg.root}>
      <h2 {...dlg.title}>{title}</h2>
      <p className="notice" role="status">
        {seatedLine}
      </p>
      {problem && (
        <p className="error" role="alert">
          {problem === "cantReach" ? t("shell.error.cantReach") : t(`checkIn.card.${problem}`)}
        </p>
      )}
      {!consent && !problem && <p role="status">{t("shell.loading")}</p>}
      {consent && !waiting && (
        <>
          <p className="small">{t("newTab.readOut")}</p>
          <blockquote className="consent" data-guest-text>
            {consent.text}
          </blockquote>
        </>
      )}
      {waiting && (
        <p role="status" aria-live="polite">
          {slow ? t("pay.unknown") : t("checkIn.card.waiting")}
        </p>
      )}
      <div className="row">
        {waiting ? (
          // While the reader waits, Cancel stops the tap; once Stripe is being checked, no retry.
          !slow && (
            <button type="button" className="secondary" onClick={() => void cancel()}>
              {t("pay.cancel")}
            </button>
          )
        ) : (
          <>
            {consent && (
              <button type="button" className="primary" disabled={busy} onClick={() => void read()}>
                {problem || tap ? t("pay.tapAgain") : t("newTab.read")}
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => onDone(`${seatedLine} · ${t("checkIn.card.skipped")}`)}
            >
              {t("checkIn.card.skip")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
