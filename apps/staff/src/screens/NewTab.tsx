import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiCallError } from "../api.js";
import { useT } from "../i18n.js";
import { TestCard } from "./TestCard.js";
import { hasReaders, useReaders } from "../useReaders.js";

/**
 * New tab, card first (M6-06; Staff screens and the bar POS · Tabs, card
 * first; Payment flows · The consent line; screens N23 and Rail note 13).
 * The panel shows the consent line, built from the tab settings, for the
 * bartender to read out; Read to guest ✓ records who read it and its version
 * and puts the bar reader to work. While the guest taps, dips or swipes, the
 * bartender types a first name or taps a label, then Open. A dip or swipe
 * brings the name; a card that already has an open tab opens it instead,
 * with no second hold. Four taps for a tapped phone: New tab, Read to guest ✓,
 * a label, Open. Where the venue turned on "Open a tab without a card"
 * (P-03), the panel leads with the name instead (U-05, D133): a name or a
 * label, then Open, and the tab opens at once with no reader and no hold;
 * Hold a card instead (only where the venue has a reader) brings back the
 * consent line and the card-first steps above.
 */
interface Consent {
  readonly version_id: string;
  readonly text: string;
  readonly asks_party_size: boolean;
  /** False when the venue turned on "Open a tab without a card" (P-03). */
  readonly card_required?: boolean;
}
interface Opening {
  readonly id: string;
  readonly state: "waiting" | "opened" | "existing" | "canceled";
  readonly payment: { readonly state: string; readonly training?: boolean };
  readonly card: { readonly brand: string | null; readonly last4: string } | null;
  readonly tab: { readonly id: string; readonly name: string } | null;
}
interface Reader {
  readonly id: string;
  readonly registered: boolean;
  readonly online: boolean;
  readonly station: "bar" | "front_desk";
}
type Problem = "readerOffline" | "noReader" | "cardRequired" | "failed" | null;

const newKey = () => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function NewTab({
  venueId,
  takenLabels,
  onOpened,
  onClose,
}: {
  venueId: string;
  /** Labels already on open tabs ("Seat 3"), which aren't offered again. */
  takenLabels: readonly string[];
  onOpened: (tab: { id: string; name: string }, existing: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [consent, setConsent] = useState<Consent | null>(null);
  const [partySize, setPartySize] = useState<number | null>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  const [readerId, setReaderId] = useState<string | null>(null);
  const [name, setName] = useState("");
  // U-05: where cards aren't required the name comes first; the card hold is the second choice.
  const [withCard, setWithCard] = useState(false);
  const readerList = useReaders(venueId);
  const [label, setLabel] = useState<string | null>(null);
  const [openPressed, setOpenPressed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const done = useRef(false);

  useEffect(() => {
    api<Consent>("GET", `/v1/venues/${venueId}/tabs/consent`)
      .then(setConsent)
      .catch(() => setProblem("failed"));
  }, [venueId]);
  useEffect(() => () => clearInterval(timer.current), []);

  // The tab opens once the hold is placed and Open was tapped; the card's open tab opens at once.
  const settle = useCallback(
    (o: Opening) => {
      setOpening(o);
      if (done.current || !o.tab) return;
      if (o.state === "existing" || (o.state === "opened" && openPressed)) {
        done.current = true;
        clearInterval(timer.current);
        onOpened(o.tab, o.state === "existing");
      }
    },
    [onOpened, openPressed],
  );
  const settleRef = useRef(settle);
  settleRef.current = settle;

  const poll = (id: string) => {
    clearInterval(timer.current);
    timer.current = setInterval(() => {
      void api<Opening>("POST", `/v1/venues/${venueId}/tabs/openings/${id}/check-status`)
        .then((o) => {
          settleRef.current(o);
          // Nothing more to hear: opened, its open tab found, canceled, or the card declined.
          if (o.state !== "waiting" || ["declined", "canceled", "failed"].includes(o.payment.state))
            clearInterval(timer.current);
        })
        .catch(() => undefined);
    }, 1000);
  };

  // Read to guest ✓: the consent is recorded and the bar reader goes to work.
  const read = async () => {
    if (!consent) return;
    setBusy(true);
    setProblem(null);
    try {
      const readers = await api<{ readers: Reader[] }>("GET", `/v1/venues/${venueId}/readers`);
      const bar = readers.readers
        .filter((r) => r.registered && r.station === "bar")
        .sort((a, b) => Number(b.online) - Number(a.online))[0];
      if (!bar) {
        setProblem("noReader");
        return;
      }
      setReaderId(bar.id);
      const o = await api<Opening>(
        "POST",
        `/v1/venues/${venueId}/tabs`,
        {
          reader_id: bar.id,
          consent_text_version: consent.version_id,
          ...(partySize ? { party_size: partySize } : {}),
        },
        { idempotencyKey: newKey() },
      );
      done.current = false;
      setOpening(o);
      poll(o.id);
    } catch (e) {
      const err = e as ApiCallError;
      setProblem(
        err instanceof ApiCallError && err.code === "reader_offline" ? "readerOffline" : "failed",
      );
    } finally {
      setBusy(false);
    }
  };

  // Open without a card (P-03): a name alone, no reader and no hold; the server refuses it unless the
  // venue turned on "Open a tab without a card".
  const openWithoutCard = async () => {
    // A tapped label alone names the tab too (the server needs a name).
    const typed = name.trim() || label;
    if (!typed) return;
    setBusy(true);
    setProblem(null);
    try {
      const o = await api<{ tab: { id: string; name: string } }>(
        "POST",
        `/v1/venues/${venueId}/tabs`,
        {
          card: "none",
          name: typed,
          label,
          ...(partySize ? { party_size: partySize } : {}),
        },
        { idempotencyKey: newKey() },
      );
      done.current = true;
      onOpened(o.tab, false);
    } catch (e) {
      const refused = e instanceof ApiCallError && e.details["reason"] === "card_required";
      setProblem(refused ? "cardRequired" : "failed");
      // The venue now opens tabs on a card: the consent line comes back to read out.
      if (refused) setWithCard(true);
    } finally {
      setBusy(false);
    }
  };

  // Open: the name or label, given while the guest taps.
  const openTab = async (picked: string | null = label) => {
    if (!opening) return;
    setBusy(true);
    try {
      const o = await api<Opening>(
        "POST",
        `/v1/venues/${venueId}/tabs/openings/${opening.id}/name`,
        { name: name.trim() || null, label: picked },
      );
      setOpenPressed(true);
      if (o.tab && (o.state === "opened" || o.state === "existing")) {
        done.current = true;
        clearInterval(timer.current);
        onOpened(o.tab, o.state === "existing");
      } else setOpening(o);
    } catch {
      setProblem("failed");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    clearInterval(timer.current);
    if (opening && opening.state === "waiting")
      await api("POST", `/v1/venues/${venueId}/tabs/openings/${opening.id}/cancel`, undefined, {
        idempotencyKey: newKey(),
      }).catch(() => undefined);
    onClose();
  };

  // A declined card: the old opening is let go and the reader asks again.
  const tryAgain = async () => {
    if (opening)
      await api("POST", `/v1/venues/${venueId}/tabs/openings/${opening.id}/cancel`, undefined, {
        idempotencyKey: newKey(),
      }).catch(() => undefined);
    setOpening(null);
    await read();
  };

  const labels = [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => t("newTab.label.seat", { n })),
    t("newTab.label.standing"),
    t("newTab.label.stage"),
    t("newTab.label.window"),
  ].filter((l) => !takenLabels.includes(l));
  const state = opening?.payment.state;
  const nameFirst = consent?.card_required === false && !withCard;

  const partySizeField = consent?.asks_party_size ? (
    <label>
      <span>{t("newTab.partySize")}</span>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={200}
        value={partySize ?? ""}
        onChange={(e) => setPartySize(Number(e.target.value) || null)}
      />
    </label>
  ) : null;
  // The guest's name, or a label in one tap: while the card is read, or first on a tab without one.
  const nameAndLabels = (
    <>
      <label>
        <span className="small">{t("newTab.name")}</span>
        <input
          value={name}
          maxLength={80}
          placeholder={t("newTab.nameHint")}
          aria-label={t("newTab.name")}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="labels" role="group" aria-label={t("newTab.labels")}>
        <span className="small">{t("newTab.labels")}</span>
        {labels.map((l) => (
          <button
            key={l}
            type="button"
            className={label === l ? "chip on" : "chip"}
            aria-pressed={label === l}
            onClick={() => setLabel(label === l ? null : l)}
          >
            {l}
          </button>
        ))}
      </div>
    </>
  );

  return (
    <section className="new-tab" aria-label={t("newTab.title")}>
      <h2>{t("newTab.title")}</h2>
      {!consent && !problem && <p role="status">{t("shell.loading")}</p>}
      {consent && !opening && nameFirst && (
        <form
          className="new-tab-no-card"
          aria-label={t("newTab.openNoCard")}
          onSubmit={(e) => {
            e.preventDefault();
            void openWithoutCard();
          }}
        >
          {partySizeField}
          {nameAndLabels}
          <p className="small muted">{t("newTab.noCardHint")}</p>
          <button
            type="submit"
            className="primary"
            disabled={busy || (!name.trim() && !label) || (consent.asks_party_size && !partySize)}
          >
            {t("newTab.open")}
          </button>
          {hasReaders(readerList) && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setWithCard(true)}
            >
              {t("newTab.withCard")}
            </button>
          )}
        </form>
      )}
      {consent && !opening && !nameFirst && (
        <>
          <p className="small muted">{t("newTab.readOut")}</p>
          <blockquote className="consent" data-guest-text>
            {consent.text}
          </blockquote>
          {partySizeField}
          <button
            type="button"
            className="primary"
            disabled={busy || (consent.asks_party_size && !partySize)}
            onClick={() => void read()}
          >
            {t("newTab.read")}
          </button>
          {consent.card_required === false && (
            <button type="button" className="secondary" onClick={() => setWithCard(false)}>
              {t("newTab.openNoCard")}
            </button>
          )}
        </>
      )}
      {opening && (opening.state === "waiting" || opening.state === "opened") && (
        <>
          {state === "waiting" && (
            <p role="status">{openPressed ? t("newTab.opening") : t("newTab.waiting")}</p>
          )}
          {state === "waiting" && !openPressed && opening.payment.training && (
            <TestCard venueId={venueId} readerId={readerId} />
          )}
          {state === "unknown" && <p role="status">{t("pay.unknown")}</p>}
          {state === "declined" && (
            <p role="alert">
              {t("pay.declined")}{" "}
              <button type="button" className="link" onClick={() => void tryAgain()}>
                {t("pay.tapAgain")}
              </button>
            </p>
          )}
          {opening.card && (
            <p className="chip" data-guest-text>
              {opening.card.brand} ··{opening.card.last4}
            </p>
          )}
          {nameAndLabels}
          <p className="small muted">{t("newTab.lastFour")}</p>
          <button
            type="button"
            className="primary"
            disabled={busy || openPressed}
            onClick={() => void openTab()}
          >
            {t("newTab.open")}
          </button>
        </>
      )}
      {opening?.state === "canceled" && <p role="status">{t("pay.canceled")}</p>}
      {problem === "readerOffline" && <p role="alert">{t("newTab.readerOffline")}</p>}
      {problem === "noReader" && <p role="alert">{t("newTab.noReader")}</p>}
      {problem === "cardRequired" && <p role="alert">{t("newTab.cardRequired")}</p>}
      {problem === "failed" && (
        <p className="error" role="alert">
          {t("pay.failed")}
        </p>
      )}
      <button type="button" className="link" onClick={() => void cancel()}>
        {t("pay.cancel")}
      </button>
    </section>
  );
}
