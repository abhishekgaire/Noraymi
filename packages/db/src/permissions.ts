import { isAction, isRole, type Action, type PermissionOverride, type Role } from "@west4/shared";
import type { Queryable } from "./tenancy.js";

/** A venue's overrides of the default permission table. Inside a venue transaction. */
export async function permissionOverrides(
  client: Queryable,
  venueId: string,
): Promise<PermissionOverride[]> {
  const r = await client.query<{
    role: string;
    action: string;
    allowed: boolean;
    needs_approval: boolean;
  }>("select role, action, allowed, needs_approval from role_permissions where venue_id = $1", [
    venueId,
  ]);
  return r.rows
    .filter((row) => isRole(row.role) && isAction(row.action))
    .map((row) => ({
      role: row.role as Role,
      action: row.action as Action,
      allowed: row.allowed,
      needsApproval: row.needs_approval,
    }));
}

export async function setPermission(
  client: Queryable,
  venueId: string,
  role: Role,
  action: Action,
  allowed: boolean,
  needsApproval: boolean,
  updatedBy: string | undefined,
): Promise<void> {
  await client.query(
    `insert into role_permissions (venue_id, role, action, allowed, needs_approval, updated_by)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (venue_id, role, action) do update
       set allowed = excluded.allowed, needs_approval = excluded.needs_approval, updated_by = excluded.updated_by, updated_at = now()`,
    [venueId, role, action, allowed, needsApproval, updatedBy ?? null],
  );
}
