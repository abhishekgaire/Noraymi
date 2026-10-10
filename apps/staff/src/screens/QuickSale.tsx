import { useState } from "react";
import { api, ApiCallError } from "../api.js";
import { useT } from "../i18n.js";
import { AddDrinks, type DraftLine } from "./AddDrinks.js";
import {
  SendToKitchen,
  UnsentReminder,
  type CheckFood,
  type KitchenNotes,
} from "./SendToKitchen.js";
import { CashPanel, CashResult, type Taken } from "./CashPanel.js";
import { ReceiptStep } from "./ReceiptStep.js";
import { SongCredit } from "./SongCredit.js";
import { TapPayment } from "./TapPayment.js";

/**
 * Quick sale on the bar POS (M6-05; Staff screens and the bar POS · Paying at
 * the bar: Cash and Receipt): the person's own walk-up sale. The drinks are
 * rung from the grid into their quick draft; Pay makes the sale's own check
 * and opens the pay panel: a tap at the reader (its tip choices worked out on
 * the drinks before tax) or cash, one tap on what the guest handed over. Then
 * the receipt. "Back to the sale" voids an unpaid sale, keeping its number,
 * and puts its drinks back. Ringing the next drink starts the next sale.
 */
interface Sale {
  readonly check_id: string;
  readonly check_label: string;
  readonly amount_due_cents: number;
  readonly totals: { readonly total_cents: number } | null;
  readonly tip_choices: {
    readonly kind: "fixed" | "percent";
    readonly choices_cents: readonly number[];
  } | null;
  /** Its lines; food carries its kitchen state (K-05). */
  readonly lines?: readonly {
    readonly id: number;
    readonly description: string;
    readonly kitchen?: CheckFood;
  }[];
}
/** The sale's food still Not sent (K-05). */
const unsentOf = (sale: Sale | null) =>
  (sale?.lines ?? []).filter((l) => l.kitchen && !l.kitchen.sent_at && l.kitchen.open_qty > 0);

export function QuickSale({
  venueId,
  ringRequest,
  refresh,
  onChanged,
}: {
  venueId: string;
  ringRequest: { variantId: string; n: number; optionIds?: readonly string[] } | null;
  refresh: number;
  onChanged: () => void;
}) {
  const { t, money } = useT();
  const [sale, setSale] = useState<Sale | null>(null);
  const [paid, setPaid] = useState(false);
  const [cash, setCash] = useState<Taken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRing, setLastRing] = useState(0);
  // The grid tap a sale was paid from: a drinks panel shown again never rings it a second time.
  const [used, setUsed] = useState(0);

  // A drink rung after a sale was paid starts the next sale, without choosing.
  if (ringRequest && ringRequest.n !== lastRing) {
    setLastRing(ringRequest.n);
    if (paid) {
      setSale(null);
      setPaid(false);
      setCash(null);
    }
  }

  const [kitchenSaid, setKitchenSaid] = useState(false);
  /** One kitchen ticket for the sale's food, named "Bar · Seat 3" (K-05). */
  const sendFood = async (
    checkId: string,
    name: string | null,
    notes: KitchenNotes["notes"] = {},
  ) => {
    const now = await api<Sale>("GET", `/v1/venues/${venueId}/quick-sales/${checkId}`);
    const food = unsentOf(now);
    if (food.length > 0) {
      await api(
        "POST",
        `/v1/venues/${venueId}/checks/${checkId}/kitchen-sends`,
        {
          name,
          lines: food.map((l) => {
            const n = notes[`c:${l.id}`];
            return n
              ? {
                  line_id: l.id,
                  kitchen_note: n.note.trim() || null,
                  kitchen_note_allergy: n.allergy,
                }
              : { line_id: l.id };
          }),
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      setKitchenSaid(true);
    }
    setSale(await api<Sale>("GET", `/v1/venues/${venueId}/quick-sales/${checkId}`));
  };
  const pay = async (lines: readonly DraftLine[], kitchen?: { name: string | null }) => {
    setError(null);
    setKitchenSaid(false);
    const s = await api<Sale>("POST", `/v1/venues/${venueId}/quick-sales`, {
      client_order_id: crypto.randomUUID(),
      lines,
    });
    setSale(s);
    setUsed(ringRequest?.n ?? 0);
    // Send to kitchen came first: the sale is made, then its food goes to the kitchen.
    if (kitchen)
      await sendFood(s.check_id, kitchen.name).catch((e: unknown) =>
        setError(e instanceof ApiCallError ? e.message : t("kitchen.send.failed")),
      );
    onChanged();
  };
  const back = async () => {
    if (!sale) return;
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/quick-sales/${sale.check_id}/void`);
      setSale(null);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : t("drinks.failed"));
    }
  };

  if (!sale)
    return (
      <AddDrinks
        venueId={venueId}
        checkId="quick"
        search={false}
        ringRequest={ringRequest && ringRequest.n > used ? ringRequest : null}
        refresh={refresh}
        onSent={onChanged}
        onPay={pay}
      />
    );

  return (
    <section className="quick-pay" aria-label={t("rail.quickSale")}>
      <h3>
        {t("rail.quickSale")} · {sale.check_label}
      </h3>
      <p className="total">
        {t("rail.total")} <strong>{money(sale.amount_due_cents as never)}</strong>
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {kitchenSaid && (
        <p className="small kitchen-done" role="status">
          {t("kitchen.sent")}
        </p>
      )}
      {/* Food on the sale not sent yet (Pay anyway, or a send that failed): the reminder and the button. */}
      {unsentOf(sale).length > 0 && (
        <div className="kitchen-bar">
          <UnsentReminder count={unsentOf(sale).reduce((n, l) => n + l.kitchen!.open_qty, 0)} />
          <SendToKitchen
            needsName
            lines={unsentOf(sale).map((l) => ({
              key: `c:${l.id}`,
              label: l.description,
              qty: l.kitchen!.open_qty,
              note: l.kitchen!.kitchen_note ?? "",
              allergy: l.kitchen!.allergy,
            }))}
            onSend={({ notes, name }) => sendFood(sale.check_id, name, notes)}
          />
        </div>
      )}
      {paid ? (
        <>
          {cash && <CashResult venueId={venueId} taken={cash} />}
          <ReceiptStep venueId={venueId} checkId={sale.check_id} roomName={t("rail.quickSale")} />
          {/* In bar mode, the singer who bought the drink gets its song credit (M6-18). */}
          <SongCredit venueId={venueId} checkId={sale.check_id} />
          <p className="small muted">{t("rail.nextSale")}</p>
        </>
      ) : (
        <>
          {sale.tip_choices && (
            <p className="small">
              {t("rail.tipChoices", {
                list: sale.tip_choices.choices_cents.map((c) => money(c as never)).join(", "),
              })}
            </p>
          )}
          <TapPayment
            venueId={venueId}
            checkId={sale.check_id}
            dueCents={sale.amount_due_cents}
            onDone={() => {
              setPaid(true);
              onChanged();
            }}
          />
          <CashPanel
            venueId={venueId}
            checkId={sale.check_id}
            dueCents={sale.amount_due_cents}
            oneTap
            onTaken={(taken) => {
              setCash(taken);
              setPaid(true);
              onChanged();
            }}
          />
          <button type="button" className="link" onClick={() => void back()}>
            {t("rail.backToSale")}
          </button>
        </>
      )}
    </section>
  );
}
