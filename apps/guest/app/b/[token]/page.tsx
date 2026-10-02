import { notFound } from "next/navigation";
import { BookingBill, type BookingLink } from "./booking-bill";

/**
 * The guest's booking link (M4-16; screens N5): once staff Present the check,
 * the same bill the room's phones show, with the same ways to pay. M5 adds the
 * rest of the booking page (changes, cancelling, the deposit).
 */
export const dynamic = "force-dynamic";

const api = (process.env["API_URL"] ?? "http://localhost:3000").replace(/\/+$/, "");

export default async function BookingLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await fetch(`${api}/v1/public/bookings/${encodeURIComponent(token)}`, {
    cache: "no-store",
  });
  if (r.status === 404) notFound();
  if (!r.ok) throw new Error(`the booking couldn't load (${r.status})`);
  return <BookingBill token={token} initial={(await r.json()) as BookingLink} />;
}
