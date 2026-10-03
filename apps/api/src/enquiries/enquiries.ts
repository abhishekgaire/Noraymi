import {
  conversationFor,
  emitEvent,
  findOrCreateGuest,
  insertInbound,
  statesOf,
  venueModules,
  type Queryable,
} from "@west4/db";
import { businessDate } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { z } from "zod";
import { managerOnDutyAt } from "../approvals/service.js";
import { ApiError } from "../http/errors.js";

/**
 * Private-party enquiries (M5-04; API · Enquiries; Song systems and texts ·
 * Two-way inbox): the parties page's form opens a conversation of its own,
 * with the guest's message as its first text, unread and assigned to the
 * manager on duty, so it lands in Messages like a text the guest sent. Staff
 * answer by text in the thread. The inbox is texts only, so the form takes a
 * US mobile number, never an email address (Parties note 1, cautious default).
 */
export const enquiryBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** A US mobile number in E.164 (+1 and ten digits). */
    phone: z.string().regex(/^\+1[2-9]\d{9}$/, "a US mobile number, like +12125550100"),
    party_size: z.number().int().min(1).max(500),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    message: z.string().trim().max(1000).default(""),
  })
  .strict();
export type EnquiryInput = z.infer<typeof enquiryBody>;

export async function takeEnquiry(
  c: Queryable,
  venueId: string,
  input: EnquiryInput,
  now: Temporal.Instant,
) {
  const venue = (
    await c.query<{ time_zone: string; day_cutover: string }>(
      "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
      [venueId],
    )
  ).rows[0];
  if (!venue) throw new ApiError("not_found", "no such venue");
  // A public route by slug: the module is checked here, as the site's own route does.
  if (statesOf(await venueModules(c, venueId))["website"] !== "on")
    throw new ApiError("not_found", "this venue's site is off");
  const date = Temporal.PlainDate.from(input.date);
  const today = businessDate(now, venue.time_zone, venue.day_cutover).businessDate;
  if (Temporal.PlainDate.compare(date, today) < 0)
    throw new ApiError("invalid_request", "pick tonight or a later date", {
      details: { reason: "date_past" },
    });
  const guestId = await findOrCreateGuest(c, venueId, { name: input.name, phoneE164: input.phone });
  const enquiryId = (await c.query<{ id: string }>("select gen_random_uuid() as id")).rows[0]!.id;
  const conversationId = await conversationFor(c, venueId, {
    phoneE164: input.phone,
    guestId,
    contextKind: "enquiry",
    contextId: enquiryId,
  });
  await c.query(
    `insert into enquiries (id, venue_id, guest_id, party_size, date, message, conversation_id, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      enquiryId,
      venueId,
      guestId,
      input.party_size,
      input.date,
      input.message || null,
      conversationId,
      now.toString(),
    ],
  );
  // The guest's own words open the thread, so the 24-hour reply window starts now.
  await insertInbound(c, venueId, {
    conversationId,
    body: input.message || "—",
    sid: null,
    at: now.toString(),
  });
  const onDuty = await managerOnDutyAt(c, venueId, now);
  if (onDuty)
    await c.query("update conversations set assigned_to = $3 where venue_id = $1 and id = $2", [
      venueId,
      conversationId,
      onDuty,
    ]);
  await emitEvent(c, { venueId, type: "message.received", entityId: conversationId });
  return { id: enquiryId, conversation_id: conversationId };
}

export interface EnquiryRow {
  readonly id: string;
  readonly name: string;
  readonly phone_e164: string | null;
  readonly party_size: number;
  readonly date: string;
  readonly message: string | null;
  readonly status: "new" | "answered" | "closed";
  readonly conversation_id: string;
  readonly created_at: string;
}

const SELECT = `select e.id, g.name, g.phone_e164, e.party_size, e.date::text, e.message, e.status,
                       e.conversation_id, e.created_at
                  from enquiries e join guests g on g.venue_id = e.venue_id and g.id = e.guest_id`;

export async function listEnquiries(
  c: Queryable,
  venueId: string,
  page: { after: string | null; limit: number },
): Promise<EnquiryRow[]> {
  return (
    await c.query<EnquiryRow>(
      `${SELECT} where e.venue_id = $1 and ($2::timestamptz is null or e.created_at < $2::timestamptz)
        order by e.created_at desc limit $3`,
      [venueId, page.after, page.limit + 1],
    )
  ).rows;
}

/** The enquiry a conversation is about, for the thread's header. */
export async function enquiryForConversation(
  c: Queryable,
  venueId: string,
  conversationId: string,
): Promise<EnquiryRow | null> {
  return (
    (
      await c.query<EnquiryRow>(`${SELECT} where e.venue_id = $1 and e.conversation_id = $2`, [
        venueId,
        conversationId,
      ])
    ).rows[0] ?? null
  );
}
