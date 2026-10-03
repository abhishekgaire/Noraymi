"use client";
import { useState, type FormEvent } from "react";
import { t } from "@west4/shared";

/**
 * The private-party enquiry form (M5-04; screens Parties note 1): a name, a
 * mobile number, the party size, a date and anything else. The inbox is texts
 * only, so it takes a US mobile number, never an email address, and says "We
 * reply by text". It lands in the venue's Messages as an unread thread.
 */
export function EnquiryForm({ slug, today }: { slug: string; today: string }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [party, setParty] = useState("");
  const [date, setDate] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (phone.includes("@")) {
      setError(t("en", "site.enquiry.notEmail"));
      return;
    }
    const digits = phone.replace(/\D/g, "");
    const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 ? `+${digits}` : phone;
    setBusy(true);
    try {
      const r = await fetch(`/v1/public/venues/${encodeURIComponent(slug)}/enquiries`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          phone: e164,
          party_size: Number(party),
          date,
          message: message.trim(),
        }),
      });
      if (r.ok) {
        setSent(true);
        return;
      }
      const body = (await r.json().catch(() => ({}))) as {
        error?: { details?: { reason?: string } };
      };
      const reason = body.error?.details?.reason;
      setError(
        reason === "phone"
          ? t("en", "site.enquiry.badPhone")
          : reason === "date_past"
            ? t("en", "site.enquiry.pastDate")
            : t("en", "site.enquiry.failed"),
      );
    } catch {
      setError(t("en", "site.enquiry.failed"));
    } finally {
      setBusy(false);
    }
  };

  if (sent)
    return (
      <div role="status">
        <p className="lead">{t("en", "site.enquiry.sent")}</p>
        <p>{t("en", "site.enquiry.sentLine", { phone })}</p>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setSent(false);
            setMessage("");
          }}
        >
          {t("en", "site.enquiry.another")}
        </button>
      </div>
    );

  return (
    <form className="enquiry" onSubmit={(e) => void submit(e)}>
      <label>
        {t("en", "site.enquiry.name")}
        <input
          value={name}
          maxLength={80}
          autoComplete="name"
          required
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        {t("en", "site.enquiry.mobile")}
        <input
          type="tel"
          value={phone}
          autoComplete="tel"
          required
          aria-describedby="enquiry-by-text"
          onChange={(e) => setPhone(e.target.value)}
        />
        <span id="enquiry-by-text" className="small">
          {t("en", "site.enquiry.byText")}
        </span>
      </label>
      <label>
        {t("en", "site.enquiry.guests")}
        <input
          type="number"
          min={1}
          max={500}
          inputMode="numeric"
          value={party}
          required
          onChange={(e) => setParty(e.target.value)}
        />
      </label>
      <label>
        {t("en", "site.enquiry.date")}
        <input
          type="date"
          min={today}
          value={date}
          required
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <label>
        {t("en", "site.enquiry.message")}
        <textarea value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" className="button" disabled={busy}>
        {busy ? t("en", "site.enquiry.sending") : t("en", "site.enquiry.send")}
      </button>
      <p className="small">{t("en", "site.enquiry.nothingToPay")}</p>
    </form>
  );
}
