import { Spot } from "./spot";

/** The guest's own waitlist page (M2-25), behind a link token: their place in line, leaving, an offer. */
export default async function WaitlistSpotPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Spot token={token} />;
}
