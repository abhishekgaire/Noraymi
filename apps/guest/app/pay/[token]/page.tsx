import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { PayForm, type PayPage } from "./pay-form";

/**
 * Our payment page (M4-15; Stripe setup 10; Security 1), on the `pay.`
 * hostname only: the amount, and Stripe's Payment Element for Apple Pay,
 * Google Pay or a card. Rendered on every request, so the proxy's nonce
 * reaches every script.
 */
export const dynamic = "force-dynamic";

const api = (process.env["API_URL"] ?? "http://localhost:3000").replace(/\/+$/, "");

export default async function PayPageRoute({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const nonce = (await headers()).get("x-nonce") ?? "";
  const r = await fetch(`${api}/v1/public/pay/${encodeURIComponent(token)}`, {
    method: "POST",
    cache: "no-store",
  });
  if (r.status === 404) notFound();
  if (!r.ok) throw new Error(`the payment page couldn't load (${r.status})`);
  const page = (await r.json()) as PayPage;
  return <PayForm token={token} page={page} nonce={nonce} />;
}
