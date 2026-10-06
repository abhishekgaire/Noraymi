import type { Metadata } from "next";
import { t } from "@west4/shared";
import { UpNextTv } from "./tv";

export const metadata: Metadata = { title: t("en", "devices.kind.up_next_display") };

/** The Up next TV at the bar (M6-22; screens N28): a paired shared screen showing the queue. */
export default function TvPage() {
  return <UpNextTv />;
}
