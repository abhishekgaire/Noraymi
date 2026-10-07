import { emitEvent, rulePackFor, statesOf, venueModules, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import { newYorkCounty, stateOf, Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { enqueuePush } from "../push/send-push.js";
import { venueClock } from "./assignment.js";

/**
 * Incidents (M8-08; screens N20; spec 04 · incidents; D58). The guest's
 * private "Need a manager, privately?" alert and the incident log. Only
 * managers' and owners' phones read an incident (its room, time and kind)
 * and get its push; the board's channel gets only how many are open, for its
 * "Manager needed" pin. Notes are added, never edited; closing keeps the
 * incident until `keep_until` (the rule pack's incidentsYears, 3 in New York).
 */
export type IncidentKind = "unsafe" | "someone_needs_help" | "other";
export const INCIDENT_KINDS: readonly IncidentKind[] = ["unsafe", "someone_needs_help", "other"];

export interface IncidentNote {
  readonly id: string;
  readonly text: string;
  readonly added_by: string;
  readonly added_by_name: string | null;
  readonly added_at: string;
}

export interface IncidentRow {
  readonly id: string;
  readonly kind: IncidentKind;
  readonly room_id: string | null;
  readonly room_name: string | null;
  readonly reported_via: "room_page" | "staff_phone";
  readonly reported_by: string | null;
  readonly reported_by_name: string | null;
  readonly at: string;
  readonly status: "open" | "acknowledged" | "closed";
  readonly acknowledged_by: string | null;
  readonly acknowledged_by_name: string | null;
  readonly acknowledged_at: string | null;
  readonly closed_by: string | null;
  readonly closed_by_name: string | null;
  readonly closed_at: string | null;
  readonly keep_until: string | null;
  readonly notes: readonly IncidentNote[];
}

const iso = (col: string) => `to_json(${col}) #>> '{}'`;
const COLS = `i.id, i.kind, i.room_id, r.name as room_name, i.reported_via, i.reported_by, ur.name as reported_by_name,
  ${iso("i.at")} as at, i.status, i.acknowledged_by, ua.name as acknowledged_by_name, ${iso("i.acknowledged_at")} as acknowledged_at,
  i.closed_by, uc.name as closed_by_name, ${iso("i.closed_at")} as closed_at, ${iso("i.keep_until")} as keep_until,
  coalesce((select json_agg(json_build_object('id', n.id, 'text', n.text, 'added_by', n.added_by,
                    'added_by_name', un.name, 'added_at', ${iso("n.added_at")}) order by n.added_at, n.id)
              from incident_notes n left join users un on un.id = n.added_by
             where n.venue_id = i.venue_id and n.incident_id = i.id), '[]'::json) as notes
  from incidents i
  left join rooms r on r.venue_id = i.venue_id and r.id = i.room_id
  left join users ur on ur.id = i.reported_by
  left join users ua on ua.id = i.acknowledged_by
  left join users uc on uc.id = i.closed_by`;

export async function incidentById(c: Queryable, venueId: string, id: string) {
  const r = await c.query<IncidentRow>(`select ${COLS} where i.venue_id = $1 and i.id = $2`, [
    venueId,
    id,
  ]);
  return r.rows[0] ?? null;
}

/** The log, newest first: what's open (or acknowledged) first, then the closed ones. */
export async function listIncidents(c: Queryable, venueId: string, limit = 200) {
  const r = await c.query<IncidentRow>(
    `select ${COLS} where i.venue_id = $1
      order by (i.status = 'closed'), i.at desc, i.id limit $2`,
    [venueId, limit],
  );
  return r.rows;
}

/** Safety & ID records is on (or stopping): the help link, the pin and the log show. */
export async function safetyOn(c: Queryable, venueId: string): Promise<boolean> {
  return stateOf(statesOf(await venueModules(c, venueId)), "safety") !== "off";
}

/** How many are open or acknowledged: all the board ever gets. */
export async function openIncidentCount(c: Queryable, venueId: string): Promise<number> {
  const r = await c.query<{ n: number }>(
    "select count(*)::int as n from incidents where venue_id = $1 and status <> 'closed'",
    [venueId],
  );
  return r.rows[0]!.n;
}

/**
 * incident.opened or incident.updated to managers' and owners' channels only
 * (no room on the event), and the open count to the staff channel for the
 * board's pin: the venue as its entity and the count as its version, so the
 * board's channel never carries an incident, a room or a reason.
 */
async function announce(
  c: Queryable,
  venueId: string,
  incident: { id: string },
  type: "incident.opened" | "incident.updated",
  version: number,
) {
  await emitEvent(c, {
    venueId,
    type,
    entityId: incident.id,
    entityVersion: version,
    audience: "managers",
  });
  await emitEvent(c, {
    venueId,
    type: "incident.count",
    entityId: venueId,
    entityVersion: await openIncidentCount(c, venueId),
    audience: "staff",
  });
}

/**
 * The incident's version: every change adds exactly one note, the
 * acknowledgement or the close, so the sum only grows.
 */
const versionOf = async (c: Queryable, venueId: string, id: string) =>
  (
    await c.query<{ n: number }>(
      `select ((select count(*) from incident_notes n where n.venue_id = i.venue_id and n.incident_id = i.id)
               + (i.acknowledged_at is not null)::int + (i.closed_at is not null)::int)::int as n
         from incidents i where i.venue_id = $1 and i.id = $2`,
      [venueId, id],
    )
  ).rows[0]!.n;

/** "10:41 PM" in the venue's zone, for the push. */
function clockTime(at: Temporal.Instant, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at.epochMilliseconds));
}

async function pushManagers(
  c: Queryable,
  venueId: string,
  incident: IncidentRow,
  now: Temporal.Instant,
) {
  const { timeZone } = await venueClock(c, venueId);
  for (const role of ["manager", "owner"])
    await enqueuePush(c, {
      venueId,
      audience: { kind: "role", role },
      message: {
        key: `incidents.push.${incident.kind}`,
        params: {
          room: incident.room_name ?? "",
          time: clockTime(Temporal.Instant.from(incident.at), timeZone),
        },
        url: "/incidents",
        tag: `incident-${incident.id}`,
      },
      runAt: now,
    });
}

/**
 * The guest's private alert from the room page on their own phone. A second
 * tap while their alert is still open answers the same incident without
 * another push (cautious default: one alert per guest at a time).
 */
export async function openHelpAlert(
  c: Queryable,
  venueId: string,
  input: {
    roomGuestId: string;
    sessionId: string;
    roomId: string;
    kind: IncidentKind;
    now: Temporal.Instant;
  },
): Promise<IncidentRow> {
  const open = await c.query<{ id: string }>(
    `select id from incidents where venue_id = $1 and room_guest_id = $2 and status <> 'closed'
      order by at desc limit 1`,
    [venueId, input.roomGuestId],
  );
  if (open.rows[0]) return (await incidentById(c, venueId, open.rows[0].id))!;
  const id = (
    await c.query<{ id: string }>(
      `insert into incidents (venue_id, kind, room_id, session_id, room_guest_id, reported_via, at)
       values ($1, $2, $3, $4, $5, 'room_page', $6) returning id`,
      [venueId, input.kind, input.roomId, input.sessionId, input.roomGuestId, input.now.toString()],
    )
  ).rows[0]!.id;
  const incident = (await incidentById(c, venueId, id))!;
  await announce(c, venueId, incident, "incident.opened", 0);
  await pushManagers(c, venueId, incident, input.now);
  return incident;
}

/** A manager logs one by hand (POST /incidents), with its first note. */
export async function logIncident(
  c: Queryable,
  venueId: string,
  input: {
    userId: string;
    kind: IncidentKind;
    roomId: string | null;
    note: string;
    now: Temporal.Instant;
  },
): Promise<IncidentRow> {
  if (input.roomId) {
    const room = await c.query("select 1 from rooms where venue_id = $1 and id = $2", [
      venueId,
      input.roomId,
    ]);
    if (!room.rowCount) throw new ApiError("not_found", "no such room");
  }
  const id = (
    await c.query<{ id: string }>(
      `insert into incidents (venue_id, kind, room_id, reported_via, reported_by, at)
       values ($1, $2, $3, 'staff_phone', $4, $5) returning id`,
      [venueId, input.kind, input.roomId, input.userId, input.now.toString()],
    )
  ).rows[0]!.id;
  await c.query(
    "insert into incident_notes (venue_id, incident_id, text, added_by, added_at) values ($1, $2, $3, $4, $5)",
    [venueId, id, input.note, input.userId, input.now.toString()],
  );
  const incident = (await incidentById(c, venueId, id))!;
  await announce(c, venueId, incident, "incident.opened", await versionOf(c, venueId, id));
  return incident;
}

async function lockIncident(c: Queryable, venueId: string, id: string) {
  const r = await c.query<{ status: string }>(
    "select status from incidents where venue_id = $1 and id = $2 for update",
    [venueId, id],
  );
  if (!r.rows[0]) throw new ApiError("not_found", "no such incident");
  return r.rows[0].status;
}

/** I'm on it: records who and when; the incident stays open on the board until it's closed. */
export async function ackIncident(
  c: Queryable,
  venueId: string,
  id: string,
  input: { userId: string; now: Temporal.Instant },
): Promise<IncidentRow> {
  const status = await lockIncident(c, venueId, id);
  if (status === "closed") throw new ApiError("invalid_request", "this incident is closed");
  if (status === "open") {
    await c.query(
      `update incidents set status = 'acknowledged', acknowledged_by = $3, acknowledged_at = $4
        where venue_id = $1 and id = $2`,
      [venueId, id, input.userId, input.now.toString()],
    );
    await announce(c, venueId, { id }, "incident.updated", await versionOf(c, venueId, id));
  }
  return (await incidentById(c, venueId, id))!;
}

/** A note goes to the log and is never edited. A closed incident still takes one. */
export async function addIncidentNote(
  c: Queryable,
  venueId: string,
  id: string,
  input: { userId: string; text: string; now: Temporal.Instant },
): Promise<IncidentRow> {
  await lockIncident(c, venueId, id);
  await c.query(
    "insert into incident_notes (venue_id, incident_id, text, added_by, added_at) values ($1, $2, $3, $4, $5)",
    [venueId, id, input.text, input.userId, input.now.toString()],
  );
  await emitEvent(c, {
    venueId,
    type: "incident.updated",
    entityId: id,
    entityVersion: await versionOf(c, venueId, id),
    audience: "managers",
  });
  return (await incidentById(c, venueId, id))!;
}

/** How many years the venue's rule pack keeps an incident on a business date (3 in New York). */
export async function incidentYears(
  c: Queryable,
  venueId: string,
  at: Temporal.Instant,
): Promise<number> {
  const venue = await c.query<{ rule_pack_id: string | null }>(
    "select rule_pack_id from venues where id = $1",
    [venueId],
  );
  const { timeZone, dayCutover } = await venueClock(c, venueId);
  const date = Temporal.PlainDate.from(businessDate(at, timeZone, dayCutover).businessDate);
  const pack = await rulePackFor(c, venue.rows[0]?.rule_pack_id ?? newYorkCounty.id, date);
  return pack?.pack.retention.incidentsYears ?? newYorkCounty.retention.incidentsYears;
}

/** The date a closed incident is kept until: the close plus the rule pack's years, in venue time. */
export async function keepUntil(
  c: Queryable,
  venueId: string,
  closedAt: Temporal.Instant,
): Promise<Temporal.Instant> {
  const { timeZone } = await venueClock(c, venueId);
  const years = await incidentYears(c, venueId, closedAt);
  return closedAt.toZonedDateTimeISO(timeZone).add({ years }).toInstant();
}

export async function closeIncident(
  c: Queryable,
  venueId: string,
  id: string,
  input: { userId: string; now: Temporal.Instant },
): Promise<IncidentRow> {
  const status = await lockIncident(c, venueId, id);
  if (status !== "closed") {
    const until = await keepUntil(c, venueId, input.now);
    await c.query(
      `update incidents set status = 'closed', closed_by = $3, closed_at = $4, keep_until = $5,
              acknowledged_by = coalesce(acknowledged_by, $3), acknowledged_at = coalesce(acknowledged_at, $4)
        where venue_id = $1 and id = $2`,
      [venueId, id, input.userId, input.now.toString(), until.toString()],
    );
    await announce(c, venueId, { id }, "incident.updated", await versionOf(c, venueId, id));
  }
  return (await incidentById(c, venueId, id))!;
}
