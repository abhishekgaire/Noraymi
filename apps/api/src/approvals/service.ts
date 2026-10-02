import {
  approvalById,
  approvalPeople,
  decideApproval,
  emitEvent,
  insertApproval,
  managerOnDuty,
  type ApprovalRow,
  type Queryable,
} from "@west4/db";
import { businessDate, routeApproval } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { enqueuePush } from "../push/send-push.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * Approvals (M2-15; spec 02 · Approvals; spec 08 · Conventions). A write that
 * needs approval doesn't fail: it records what would run, routes it to the
 * manager on duty (or past them, for their own), pushes it to the approver's
 * phone and answers `202 approval_pending` with who it waits for. The change
 * runs when the approver approves it on their own phone.
 */
export class TargetGone extends Error {}

/** What runs when an approval of a kind is approved. Each later ticket adds its kind. */
export type Executor = (
  c: Queryable,
  venueId: string,
  approval: ApprovalRow,
  ctx: { approverId: string; at: Temporal.Instant },
) => Promise<void>;

/** Registered by the module that owns each kind (rooms/faults.ts: comp and clock_pause). */
export const executors = new Map<string, Executor>();

/** What runs when an approval of a kind is declined, for kinds that held something (card_on_file, M4-17). */
export const declineHandlers = new Map<string, Executor>();

/**
 * The manager on duty at an instant (spec 02 · Approvals): the one function
 * approvals, room-order escalation and alerts all ask. Until M7's time clock,
 * it reads the night's `duty_managers` row.
 */
export async function managerOnDutyAt(
  c: Queryable,
  venueId: string,
  at: Temporal.Instant,
): Promise<string | null> {
  const venue = await venueClock(c, venueId);
  const date = businessDate(at, venue.timeZone, venue.dayCutover).businessDate.toString();
  return managerOnDuty(c, venueId, date);
}

export interface PendingAnswer {
  readonly status: "approval_pending";
  readonly approval_id: string;
  readonly waiting_for: { readonly user_id: string; readonly name: string };
}

export async function requestApproval(
  c: Queryable,
  venueId: string,
  input: {
    kind: string;
    targetKind: string;
    targetId: string;
    amountCents: number | null;
    reason: string;
    payload: Record<string, unknown>;
    requestedBy: string;
    requestedDeviceId: string | null;
    now: Temporal.Instant;
  },
): Promise<PendingAnswer> {
  if (!input.reason.trim()) throw new ApiError("invalid_request", "an approval needs a reason");
  const people = await approvalPeople(c, venueId);
  const routedTo = routeApproval({
    requester: input.requestedBy,
    managerOnDuty: await managerOnDutyAt(c, venueId, input.now),
    people,
  });
  if (!routedTo) throw new ApiError("invalid_request", "there's nobody to approve this");
  const id = await insertApproval(c, venueId, {
    ...input,
    requestedAt: input.now.toString(),
    routedTo,
  });
  const approver = people.find((p) => p.id === routedTo)!;
  await emitEvent(c, {
    venueId,
    type: "approval.requested",
    entityId: id,
    entityVersion: 0,
    audience: "user",
    userId: routedTo,
  });
  await emitEvent(c, {
    venueId,
    type: "approval.requested",
    entityId: id,
    entityVersion: 0,
    audience: "user",
    userId: input.requestedBy,
  });
  await enqueuePush(c, {
    venueId,
    audience: { kind: "person", userId: routedTo },
    message: {
      key: "approvals.push",
      params: { name: people.find((p) => p.id === input.requestedBy)?.name ?? "" },
      url: "/approvals",
      tag: `approval-${id}`,
    },
    runAt: input.now,
  });
  return {
    status: "approval_pending",
    approval_id: id,
    waiting_for: { user_id: routedTo, name: approver.name },
  };
}

/**
 * Decides an approval: only the person it's routed to, on their own staff
 * phone, in a passkey session, never the requester and never from the
 * requester's device. Approving runs what was asked; a target that's gone
 * expires it instead; declining changes nothing.
 */
export async function decide(
  c: Queryable,
  venueId: string,
  id: string,
  input: {
    decision: "approve" | "decline";
    userId: string;
    deviceId: string;
    at: Temporal.Instant;
  },
): Promise<ApprovalRow> {
  const approval = await approvalById(c, venueId, id, true);
  if (!approval) throw new ApiError("not_found", "no such approval");
  if (approval.status !== "pending")
    throw new ApiError("version_conflict", `it's already ${approval.status}`);
  if (approval.requested_by === input.userId)
    throw new ApiError("forbidden", "nobody approves their own request");
  if (approval.routed_to !== input.userId)
    throw new ApiError("forbidden", `this is waiting for ${approval.routed_to_name}`);
  if (approval.requested_device_id === input.deviceId)
    throw new ApiError("forbidden", "an approval is never decided on the device that asked for it");
  let status: "approved" | "declined" | "expired" =
    input.decision === "approve" ? "approved" : "declined";
  if (status === "approved") {
    const run = executors.get(approval.kind);
    if (!run) throw new ApiError("internal", `nothing runs approvals of kind ${approval.kind} yet`);
    await c.query("savepoint run_approval");
    try {
      await run(c, venueId, approval, { approverId: input.userId, at: input.at });
    } catch (e) {
      if (!(e instanceof TargetGone)) throw e;
      await c.query("rollback to savepoint run_approval");
      status = "expired";
    }
  }
  if (status === "declined")
    await declineHandlers.get(approval.kind)?.(c, venueId, approval, {
      approverId: input.userId,
      at: input.at,
    });
  await decideApproval(c, venueId, id, {
    status,
    approverId: input.userId,
    deviceId: input.deviceId,
    at: input.at.toString(),
  });
  for (const userId of [approval.requested_by, approval.routed_to])
    await emitEvent(c, {
      venueId,
      type: "approval.decided",
      entityId: id,
      entityVersion: 0,
      audience: "user",
      userId,
    });
  return (await approvalById(c, venueId, id))!;
}
