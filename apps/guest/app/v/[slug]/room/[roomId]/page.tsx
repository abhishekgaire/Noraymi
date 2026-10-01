import { JoinRoom } from "./join-room";

/** The page behind a room's wall QR (M3-08; screens N3): type the room's 5-character code to join. */
export default async function JoinRoomPage({
  params,
}: {
  params: Promise<{ slug: string; roomId: string }>;
}) {
  const { slug, roomId } = await params;
  return <JoinRoom slug={slug} roomId={roomId} />;
}
