"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { t } from "@west4/shared";
import { captchaRefusal, useCaptcha } from "../../../captcha";

/**
 * Name, mobile and party size; a US number becomes +1…, and the page moves to the guest's own link.
 * The security check (M2-27) sends its token with the join; past a daily limit the guest is sent to the host.
 */
export function JoinForm({ slug }: { slug: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [party, setParty] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const captcha = useCaptcha("waitlist");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const digits = phone.replace(/\D/g, "");
    const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 ? `+${digits}` : phone;
    try {
      const r = await fetch(`/v1/public/venues/${encodeURIComponent(slug)}/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          phone: e164,
          party_size: Number(party),
          captcha_token: captcha.token ?? "",
        }),
      });
      const body = (await r.json()) as {
        token?: string;
        error?: { code?: string; details?: { reason?: string } };
      };
      if (!r.ok || !body.token) {
        captcha.reset();
        setError(
          captchaRefusal(body, "guestLimit.waitlist") ??
            (body.error?.details?.reason === "already_waiting"
              ? t("en", "guestWait.already")
              : t("en", "guestWait.failed")),
        );
        return;
      }
      router.replace(`/w/${body.token}`);
    } catch {
      captcha.reset();
      setError(t("en", "guestWait.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="guest">
      <h1>{t("en", "guestWait.titlePlain")}</h1>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          {t("en", "guestWait.name")}
          <input
            value={name}
            maxLength={80}
            autoComplete="given-name"
            required
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          {t("en", "guestWait.mobile")}
          <input
            type="tel"
            value={phone}
            autoComplete="tel"
            required
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        <label>
          {t("en", "guestWait.party")}
          <input
            type="number"
            min={1}
            max={40}
            inputMode="numeric"
            value={party}
            required
            onChange={(e) => setParty(e.target.value)}
          />
        </label>
        {captcha.widget}
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy || !name.trim() || !phone || !party || !captcha.token}>
          {busy ? t("en", "guestWait.joining") : t("en", "guestWait.join")}
        </button>
      </form>
    </main>
  );
}
