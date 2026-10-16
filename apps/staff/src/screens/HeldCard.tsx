import { useState } from "react";
import { api } from "../api.js";
import { useT } from "../i18n.js";

/**
 * The guest's card kept behind the bar (O-08; D116), on a room's check or a bar tab (U-23; D134): the
 * name on the card and its last 4, each optional on a tab, never the full number. Nothing is charged
 * to it; close-out ends with Give the card back and Returned.
 */
export interface HeldCard {
  readonly name: string | null;
  readonly last4: string | null;
  readonly returned: boolean;
}

type T = ReturnType<typeof useT>["t"];

/** "M. TORRES ···· 4242", "M. TORRES", "···· 4242", or "" when nothing was typed. */
export function heldCardDetail(held: { name: string | null; last4: string | null }): string {
  return [held.name ? held.name.toUpperCase() : null, held.last4 ? `···· ${held.last4}` : null]
    .filter(Boolean)
    .join(" ");
}

/** "Card behind the bar · M. TORRES ···· 4242", or "Card behind the bar" alone. */
export function heldCardChip(t: T, held: { name: string | null; last4: string | null }): string {
  const detail = heldCardDetail(held);
  return detail ? t("heldCard.chipDetail", { detail }) : t("heldCard.chipBare");
}

/** The end of close-out with a card behind the bar (O-08; D116; U-23): give it back, then Returned. */
export function GiveCardBack({
  venueId,
  checkId,
  held,
  onReturned,
}: {
  venueId: string;
  checkId: string;
  held: HeldCard;
  onReturned: (held: HeldCard) => void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (held.returned)
    return (
      <p className="notice" role="status">
        {t("heldCard.returnedDone")}
      </p>
    );
  const detail = heldCardDetail(held);
  return (
    <div className="card give-card-back" role="group" aria-label={t("heldCard.giveBack")}>
      <h2>{t("heldCard.giveBack")}</h2>
      <p data-guest-text>
        {detail ? t("heldCard.giveBackHintDetail", { detail }) : t("heldCard.giveBackHintBare")}
      </p>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setFailed(false);
          api<{ held_card: HeldCard }>(
            "POST",
            `/v1/venues/${venueId}/checks/${checkId}/held-card/returned`,
          )
            .then((r) => onReturned(r.held_card))
            .catch(() => setFailed(true))
            .finally(() => setBusy(false));
        }}
      >
        {t("heldCard.returned")}
      </button>
    </div>
  );
}
