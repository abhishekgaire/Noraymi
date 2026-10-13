import { insertPrintJob, latestSetting, moduleOn, type Queryable } from "@west4/db";
import { t, type Locale, type Temporal } from "@west4/shared";
import type { EmailSettings } from "../email/settings.js";
import { ApiError } from "../http/errors.js";
import { enqueueEmail } from "../jobs/send-email.js";
import type { RoomQrPayload } from "../print/room-qr.js";
import { openRoomCode } from "./room-code.js";

/**
 * The room's join QR (F-07; D124; spec 09 · Room QR slip): printed on the front desk's receipt
 * printer at every room start while Ordering from the room is on, emailed to the host when their
 * email is known, and again on Reprint QR or Email it again, always with the room's current code.
 * The join link carries the code, so the join page fills it in.
 */
interface SessionFacts {
  readonly sessionId: string;
  readonly checkId: string | null;
  readonly roomId: string;
  readonly room: string;
  readonly venue: string;
  readonly slug: string;
  readonly code: string;
  readonly training: boolean;
  readonly host: string | null;
  readonly hostEmail: string | null;
  readonly hostLocale: Locale;
}

async function sessionFacts(
  c: Queryable,
  venueId: string,
  sessionId: string,
): Promise<SessionFacts | null> {
  const r = await c.query<{
    id: string;
    check_id: string | null;
    room_id: string;
    room: string;
    venue: string;
    slug: string;
    room_code_enc: string | null;
    training: boolean;
    host: string | null;
    email: string | null;
    locale: string | null;
  }>(
    `select s.id, s.check_id, s.room_id, r.name as room, v.name as venue, v.slug, s.room_code_enc,
            s.training, g.name as host, g.email, g.locale
       from room_sessions s
       join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
       join venues v on v.id = s.venue_id
       left join guests g on g.venue_id = s.venue_id and g.id = s.guest_id
      where s.venue_id = $1 and s.id = $2 and s.ended_at is null`,
    [venueId, sessionId],
  );
  const s = r.rows[0];
  if (!s) return null;
  const code = openRoomCode(s.room_code_enc);
  if (!code) return null;
  return {
    sessionId: s.id,
    checkId: s.check_id,
    roomId: s.room_id,
    room: s.room,
    venue: s.venue,
    slug: s.slug,
    code,
    training: s.training,
    host: s.host,
    hostEmail: s.email,
    hostLocale: s.locale === "es" ? "es" : "en",
  };
}

const joinUrl = (guestAppUrl: string, f: SessionFacts) =>
  `${guestAppUrl.replace(/\/$/, "")}/v/${encodeURIComponent(f.slug)}/room/${f.roomId}?code=${encodeURIComponent(f.code)}`;

/** Print the slip; null when Ordering from the room is off or the session isn't open. */
export async function printRoomQr(
  c: Queryable,
  venueId: string,
  sessionId: string,
  input: { now: Temporal.Instant; guestAppUrl: string | null },
): Promise<{ print_job_id: string; reprint_n: number } | null> {
  if (!input.guestAppUrl || !(await moduleOn(c, venueId, "room_ordering"))) return null;
  const f = await sessionFacts(c, venueId, sessionId);
  if (!f) return null;
  const languages = ((await latestSetting(c, venueId, "languages"))?.value.staff ?? ["en"]).filter(
    (l): l is Locale => l === "en" || l === "es",
  );
  const first = languages[0] ?? "en";
  const payload: RoomQrPayload = {
    venue: f.venue,
    room: f.room,
    host: f.host,
    url: joinUrl(input.guestAppUrl, f),
    code: f.code,
    scan: (languages.length ? languages : (["en"] as Locale[])).map((l) => t(l, "roomQr.scan")),
    codeLabel: t(first, "roomQr.code"),
    ...(f.training ? { training: true } : {}),
  };
  // The first slip of a session is 0; Reprint QR counts on from there.
  const reprintN = f.checkId
    ? (
        await c.query<{ n: number }>(
          "select count(*)::int as n from print_jobs where venue_id = $1 and kind = 'room_qr' and check_id = $2",
          [venueId, f.checkId],
        )
      ).rows[0]!.n
    : 0;
  const id = await insertPrintJob(c, venueId, {
    kind: "room_qr",
    checkId: f.checkId,
    station: "front_desk",
    payload,
    reprintN,
    createdAt: input.now.toString(),
  });
  return { print_job_id: id, reprint_n: reprintN };
}

/** Email the host the QR and the join link; null when there's no email, no ordering, or practice. */
export async function emailRoomQr(
  c: Queryable,
  venueId: string,
  sessionId: string,
  input: {
    now: Temporal.Instant;
    guestAppUrl: string | null;
    email: Pick<EmailSettings, "allowList">;
    again?: boolean;
  },
): Promise<{ to: string } | null> {
  if (!input.guestAppUrl || !(await moduleOn(c, venueId, "room_ordering"))) return null;
  const f = await sessionFacts(c, venueId, sessionId);
  if (!f?.hostEmail || f.training) return null;
  try {
    await enqueueEmail(c, input.email, {
      venueId,
      to: f.hostEmail,
      locale: f.hostLocale,
      template: "room_qr",
      runAt: input.now,
      dedupeKey: input.again ? undefined : `room_qr:${sessionId}`,
      data: {
        venueName: f.venue,
        room: f.room,
        code: f.code,
        joinUrl: joinUrl(input.guestAppUrl, f),
      },
    });
  } catch (e) {
    // An address the server may not email (staging's allow list) never blocks seating the party.
    if (e instanceof ApiError && !input.again) return null;
    throw e;
  }
  return { to: f.hostEmail };
}
