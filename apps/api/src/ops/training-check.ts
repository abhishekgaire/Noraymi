import type { Queryable } from "@west4/db";

/**
 * The training check before a live night (M9-10; spec 13 · Training mode): nobody is in
 * training mode, and no device is either, except a new hire's phone or a screen named on
 * purpose with --allow-device. Read-only; names people and devices only.
 */
export interface TrainingFinding {
  readonly kind: "person" | "device";
  readonly name: string;
  readonly detail: string;
}

export interface TrainingEvidence {
  readonly people: readonly TrainingFinding[];
  readonly devices: readonly TrainingFinding[];
  readonly allowed: readonly string[];
  readonly ok: boolean;
}

export async function trainingEvidence(
  c: Queryable,
  venueId: string,
  allowDevices: readonly string[],
): Promise<TrainingEvidence> {
  const people = await c.query<{ name: string; role: string }>(
    `select u.name, m.role from memberships m join users u on u.id = m.user_id
      where m.venue_id = $1 and m.training and m.status <> 'deactivated' order by u.name`,
    [venueId],
  );
  const devices = await c.query<{ name: string; kind: string }>(
    `select name, kind from devices
      where venue_id = $1 and training and revoked_at is null and disabled_at is null order by name`,
    [venueId],
  );
  const allow = new Set(allowDevices.map((d) => d.toLowerCase()));
  const allowed = devices.rows.filter((d) => allow.has(d.name.toLowerCase())).map((d) => d.name);
  const found = {
    people: people.rows.map((p) => ({
      kind: "person" as const,
      name: p.name,
      detail: `${p.role} in training mode: turn it off in Admin → Team`,
    })),
    devices: devices.rows
      .filter((d) => !allow.has(d.name.toLowerCase()))
      .map((d) => ({
        kind: "device" as const,
        name: d.name,
        detail: `${d.kind} in training mode: turn it off in Admin → Team, or name it with --allow-device if it's a new hire's phone on purpose`,
      })),
  };
  return { ...found, allowed, ok: found.people.length === 0 && found.devices.length === 0 };
}

export function trainingReport(slug: string, e: TrainingEvidence): string {
  const rows = [...e.people, ...e.devices];
  return [
    `# Training check · ${slug}`,
    "",
    ...(e.ok
      ? ["Nobody and no device is in training mode."]
      : [
          "| In training | Name | What to do |",
          "| --- | --- | --- |",
          ...rows.map((f) => `| ${f.kind} | ${f.name} | ${f.detail} |`),
        ]),
    ...(e.allowed.length ? ["", `In device training on purpose: ${e.allowed.join(", ")}.`] : []),
    "",
  ].join("\n");
}
