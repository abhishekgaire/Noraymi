import { JoinForm } from "./join-form";

/** The page behind the door QR (M2-25): join the waitlist with a name, a mobile and a party size. */
export default async function WaitlistJoinPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <JoinForm slug={slug} />;
}
