"use client";

import { useEffect, useState } from "react";
import { t } from "@west4/shared";
import { YourBill, type GuestBill } from "../../bill/your-bill";

export interface BookingLink {
  readonly venue_name: string;
  readonly guest_name: string | null;
  readonly party_size: number;
  readonly starts_at: string;
  readonly status: string;
  readonly bill: GuestBill | null;
}

/** How often the booking link reads the bill again, so payments show as they land. */
const REFRESH_MS = 15_000;

export function BookingBill({ token, initial }: { token: string; initial: BookingLink }) {
  const [link, setLink] = useState(initial);
  const path = `/v1/public/bookings/${encodeURIComponent(token)}`;
  useEffect(() => {
    const timer = setInterval(() => {
      void fetch(path, { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<BookingLink>) : null))
        .then((next) => next && setLink(next))
        .catch(() => undefined);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [path]);

  return (
    <main className="guest booking-link">
      <header>
        <p className="venue">{link.venue_name}</p>
        <h1>{link.guest_name ?? link.venue_name}</h1>
        <p>{t("en", "bookingLink.party", { n: link.party_size })}</p>
      </header>
      {link.bill ? (
        <YourBill
          bill={link.bill}
          payLink={async () => {
            const r = await fetch(`${path}/pay-link`, { method: "POST" });
            return r.ok ? ((await r.json()) as { url: string }).url : null;
          }}
          payCash={async () => (await fetch(`${path}/cash`, { method: "POST" })).ok}
        />
      ) : (
        <p role="status">{t("en", "bookingLink.noBill")}</p>
      )}
    </main>
  );
}
