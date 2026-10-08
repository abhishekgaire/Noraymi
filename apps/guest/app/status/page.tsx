import { t } from "@west4/shared";
import { StatusBoard } from "./status-board";

/**
 * The public status page (M8-16; spec 13 · Watching production): ordering, payments, printing
 * and texts, each Working, Having trouble, Down or Maintenance, with a public note. It reads
 * GET /v1/public/status from the browser every 30 seconds, so when our API can't be reached the page
 * says so instead of showing a stale "Working".
 */
export const metadata = { title: t("en", "status.title") };

export default function StatusPage() {
  return <StatusBoard />;
}
