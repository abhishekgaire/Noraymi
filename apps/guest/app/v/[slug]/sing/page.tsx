import type { Metadata } from "next";
import { t } from "@west4/shared";
import { SingQueue } from "./sing-queue";

export const metadata: Metadata = { title: t("en", "guestSing.title") };

/**
 * The singer's queue page (M6-20; screens N9): reached from the site's "Sing at the bar", the waitlist
 * page and the QR code on the Up next TV. Joining, the song search, My songs, the place in line and
 * the credits; the singer's cookie reaches only their own songs.
 */
export default async function SingQueuePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <SingQueue slug={slug} />;
}
