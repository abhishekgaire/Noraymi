import { t, type DepositRule, type MessageKey, type PaySettings } from "@west4/shared";

/**
 * The deposit and cancelling policy guests accept (M5-06; Payment flows ·
 * What the guest sees on the booking page; Data model · policy_versions),
 * built from Admin → Deposits & cancelling, in the venue's language (English
 * at West 4). It says the deposit comes off the bill; that the card is saved,
 * and which later charges can go on it, how each is worked out and when; the
 * refund cut-off; and the gratuity sentence. Book and Manage both read it,
 * and each booking keeps the version it accepted.
 */
const dollars = (c: number): string => {
  const whole = `$${(c / 100).toFixed(2)}`;
  return whole.endsWith(".00") ? whole.slice(0, -3) : whole;
};
const en = (key: MessageKey, params?: Record<string, string | number>) => t("en", key, params);

export function depositPolicyText(
  deposit: DepositRule,
  gratuity: Pick<PaySettings["gratuity"], "auto" | "pct">,
): string {
  const lines: string[] = [];
  const hold = deposit.mode === "cardHold";
  const hours = deposit.refundHours;
  const grace = deposit.graceMin;
  if (!deposit.on) lines.push(en("policy.deposit.off"));
  else {
    switch (deposit.mode) {
      case "firstHour":
        lines.push(en("policy.deposit.firstHour"));
        break;
      case "perPerson":
        lines.push(en("policy.deposit.perPerson", { amount: dollars(deposit.value) }));
        break;
      case "flat":
        lines.push(en("policy.deposit.flat", { amount: dollars(deposit.value) }));
        break;
      case "percent":
        lines.push(en("policy.deposit.percent", { pct: deposit.value }));
        break;
      case "cardHold":
        lines.push(en("policy.deposit.cardHold"));
        break;
    }
    const big = deposit.bigParty;
    if (big)
      lines.push(
        big.deposit.kind === "flat"
          ? en("policy.bigParty.flat", {
              n: big.fromGuests,
              amount: dollars(big.deposit.cents),
              hours: big.refundHours,
            })
          : en("policy.bigParty.pct", {
              n: big.fromGuests,
              pct: big.deposit.pct,
              hours: big.refundHours,
            }),
      );
    // The saved card: what can go on it later, how much, and when.
    lines.push(en("policy.card"));
    lines.push(en(hold ? "policy.refund.cardHold" : "policy.refund", { hours }));
    if (!hold) lines.push(en(`policy.late.${deposit.late}`));
    lines.push(
      deposit.noShow === "firstHour"
        ? en("policy.noShow.firstHour", { grace })
        : en(hold ? "policy.noShow.cardHold" : `policy.noShow.${deposit.noShow}`, { grace }),
    );
  }
  if (gratuity.auto === "rooms" || gratuity.auto === "all")
    lines.push(en("policy.gratuity", { pct: gratuity.pct }));
  return lines.join("\n");
}
