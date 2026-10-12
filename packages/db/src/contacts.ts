import { businessDate } from "@west4/rules";
import { CONTACTS_EMPTY, type ContactsSettings, type Temporal } from "@west4/shared";
import { emitEvent } from "./events.js";
import type { Queryable } from "./tenancy.js";

/**
 * The venue's own contacts (D115; spec 17 · Step details 9): only an active owner or manager can
 * hold a slot. When one is deactivated, or stops being an owner or a manager, their on-call and
 * breach slots empty in a new version of the `contacts` key (saved by whoever made the change),
 * so Set up your venue and Admin → Setup show the team step as needing attention. Our own
 * platform rota (`oncall_rota`) is never read or written here.
 */
export function withoutMember(value: ContactsSettings, membershipId: string): ContactsSettings {
  const keep = <T extends { membershipId: string } | null>(slot: T): T | null =>
    slot && slot.membershipId === membershipId ? null : slot;
  const person = (id: string | null) => (id === membershipId ? null : id);
  return {
    bookingEmails: value.bookingEmails,
    onCall: { first: keep(value.onCall.first), second: keep(value.onCall.second) },
    breach: { primary: person(value.breach.primary), backup: person(value.breach.backup) },
  };
}

/** Empties a person's contact slots; true when a slot held them. Inside a venue transaction. */
export async function clearContactSlots(
  c: Queryable,
  venueId: string,
  membershipId: string,
  input: { savedBy: string | null; at: Temporal.Instant },
): Promise<boolean> {
  const row = (
    await c.query<{ value: ContactsSettings }>(
      `select value from venue_settings where venue_id = $1 and key = 'contacts'
        order by version desc limit 1`,
      [venueId],
    )
  ).rows[0];
  const before = row?.value ?? CONTACTS_EMPTY;
  const after = withoutMember(before, membershipId);
  if (JSON.stringify(after) === JSON.stringify(before)) return false;
  const venue = (
    await c.query<{ time_zone: string; cutover: string }>(
      "select time_zone, to_char(day_cutover, 'HH24:MI') as cutover from venues where id = $1",
      [venueId],
    )
  ).rows[0]!;
  const today = businessDate(input.at, venue.time_zone, venue.cutover).businessDate;
  const saved = await c.query<{ version: number }>(
    `insert into venue_settings (venue_id, key, version, value, saved_by, starts_on)
     select $1, 'contacts', coalesce(max(version), 0) + 1, $2, $3, $4
       from venue_settings where venue_id = $1 and key = 'contacts'
     returning version`,
    [venueId, JSON.stringify(after), input.savedBy, today.toString()],
  );
  await emitEvent(c, {
    venueId,
    type: "settings.changed",
    entityId: "contacts",
    entityVersion: saved.rows[0]!.version,
  });
  return true;
}

/** One named contact as our team reads it (the Console's venue page, our runbooks). */
export interface ContactLine {
  readonly slot: "on_call_first" | "on_call_second" | "breach_primary" | "breach_backup";
  readonly name: string;
  readonly role: string;
  readonly phone_e164: string | null;
  readonly email: string | null;
  /** On-call only: the days (0 Sunday to 6 Saturday) and hours they answer, venue time. */
  readonly days: readonly number[] | null;
  readonly from: string | null;
  readonly to: string | null;
}

/** The venue's contacts with each person's name, phone and email. Inside a venue transaction. */
export async function venueContacts(c: Queryable, venueId: string): Promise<ContactLine[]> {
  const row = (
    await c.query<{ value: ContactsSettings }>(
      `select value from venue_settings where venue_id = $1 and key = 'contacts'
        order by version desc limit 1`,
      [venueId],
    )
  ).rows[0];
  const v = row?.value ?? CONTACTS_EMPTY;
  const slots: [ContactLine["slot"], string | null, ContactsSettings["onCall"]["first"]][] = [
    ["on_call_first", v.onCall.first?.membershipId ?? null, v.onCall.first],
    ["on_call_second", v.onCall.second?.membershipId ?? null, v.onCall.second],
    ["breach_primary", v.breach.primary, null],
    ["breach_backup", v.breach.backup, null],
  ];
  const ids = slots.map((s) => s[1]).filter((id): id is string => id !== null);
  if (ids.length === 0) return [];
  const people = await c.query<{
    id: string;
    name: string;
    role: string;
    phone_e164: string | null;
    email: string | null;
  }>(
    `select m.id, u.name, m.role, case when u.phone_verified_at is not null then u.phone_e164 end as phone_e164,
            u.email
       from memberships m join users u on u.id = m.user_id
      where m.venue_id = $1 and m.id = any($2::uuid[]) and m.status = 'active'`,
    [venueId, ids],
  );
  const byId = new Map(people.rows.map((p) => [p.id, p]));
  const out: ContactLine[] = [];
  for (const [slot, id, onCall] of slots) {
    const p = id ? byId.get(id) : undefined;
    if (!p) continue;
    out.push({
      slot,
      name: p.name,
      role: p.role,
      phone_e164: p.phone_e164,
      email: p.email,
      days: onCall?.days ?? null,
      from: onCall?.from ?? null,
      to: onCall?.to ?? null,
    });
  }
  return out;
}
