import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";

/** A ticket that didn't print, as the list of failed print jobs answers it. */
export interface FailedJob {
  readonly id: string;
  readonly room_name?: string | null;
  /** A kitchen ticket (K-03), wherever it was sent. */
  readonly kitchen?: boolean;
}

/** Where a reprint goes: the ticket's own printer, or the bar's for a kitchen ticket. */
export type ReprintAt = "own" | "bar";

/**
 * "Ticket didn't print · Reprint" (M3-13), and for a kitchen ticket "Kitchen ticket didn't print"
 * with the kitchen printer again or Print at the bar instead, so a runner carries the slip (K-03).
 */
export function FailedTicket({
  job,
  onReprint,
  withRoom = false,
}: {
  readonly job: FailedJob;
  readonly onReprint: (jobId: string, at: ReprintAt) => void;
  readonly withRoom?: boolean;
}) {
  const { t } = useT();
  const words = job.kitchen
    ? withRoom && job.room_name
      ? t("kitchen.ticket.failedRoom", { room: job.room_name })
      : t("kitchen.ticket.failed")
    : withRoom && job.room_name
      ? t("alert.ticket", { room: job.room_name })
      : t("barOrders.ticket.failed");
  return (
    <p className="ticket-failed" role="alert">
      <span>{words}</span>{" "}
      {job.kitchen ? (
        <span role="group" aria-label={t("kitchen.reprint.title")}>
          <button type="button" className="secondary" onClick={() => onReprint(job.id, "own")}>
            {t("kitchen.reprint.kitchen")}
          </button>{" "}
          <button type="button" className="secondary" onClick={() => onReprint(job.id, "bar")}>
            {t("kitchen.reprint.bar")}
          </button>
        </span>
      ) : (
        <button type="button" className="secondary" onClick={() => onReprint(job.id, "own")}>
          {t("alert.reprint")}
        </button>
      )}
    </p>
  );
}

/**
 * The bar POS's strip of tickets that didn't print (spec 09 · Tickets; K-03): live on print events,
 * with a 15-second check behind it like the bar orders screen. Nothing shows while none failed.
 */
export function FailedTickets({ venueId }: { readonly venueId: string }) {
  const { t } = useT();
  const { subscribe } = useEvents();
  const [jobs, setJobs] = useState<readonly FailedJob[]>([]);
  const load = useCallback(async () => {
    try {
      const r = await api<{ jobs: FailedJob[] }>(
        "GET",
        `/v1/venues/${venueId}/print-jobs?status=failed`,
      );
      setJobs(r.jobs);
    } catch {
      // The orders above carry the bar's error line; this strip keeps what it last knew.
    }
  }, [venueId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type.startsWith("print_job."))) void load();
      }),
    [subscribe, load],
  );
  const reprint = (jobId: string, at: ReprintAt) =>
    void api("POST", `/v1/venues/${venueId}/print-jobs/${jobId}/reprint`, { at })
      .catch(() => undefined)
      .then(() => load());
  if (jobs.length === 0) return null;
  return (
    <ul className="rail-tickets" aria-label={t("ticket.failed.title")}>
      {jobs.map((j) => (
        <li key={j.id}>
          <FailedTicket job={j} withRoom onReprint={reprint} />
        </li>
      ))}
    </ul>
  );
}
