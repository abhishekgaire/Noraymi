import { HostJoin } from "./host-join";

/** The link in the host's Room code text (M3-08): joins whoever opens it as the room's host. */
export default async function HostLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <HostJoin token={token} />;
}
