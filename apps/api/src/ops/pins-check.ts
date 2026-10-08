import { verifyPin, type Queryable } from "@west4/db";

/**
 * The production PIN check (M9-08; spec 02 · PINs): run before the first live night and again the
 * day before it. Read-only. For every person in the venue with a PIN:
 *
 * 1. None of the demo seed's PINs verifies for them. The seed's PINs are for staging only.
 * 2. Their PIN was set by themselves: the newest audit row that changed their PIN is an update
 *    made as their own user (an invite's or a reset link's Set your PIN). A PIN written by the
 *    seed, an import or anyone else fails, so no imported PIN can exist unnoticed.
 *
 * It names people only; it never prints, logs or returns a PIN or a verifier.
 */
export const DEMO_PINS = ["915204", "730915", "4071", "6358"] as const;

export interface PinFinding {
  readonly name: string;
  readonly role: string;
  readonly why: "demo_pin" | "not_set_by_self";
  readonly detail: string;
}

export interface PinEvidence {
  readonly checked: number;
  readonly findings: readonly PinFinding[];
  readonly ok: boolean;
}

export async function pinEvidence(
  c: Queryable,
  venueId: string,
  pepper: Buffer,
): Promise<PinEvidence> {
  const people = await c.query<{
    id: string;
    user_id: string;
    name: string;
    role: string;
    pin_verifier: string;
    action: string | null;
    actor: string | null;
  }>(
    `select m.id, m.user_id, u.name, m.role, m.pin_verifier, a.action, a.actor::text
       from memberships m join users u on u.id = m.user_id
       left join lateral (
         select l.action, l.actor from audit_log l
          where l.venue_id = m.venue_id and l.target = 'memberships/' || m.id::text
            and 'pin_verifier' = any(l.changed_fields)
          order by l.id desc limit 1) a on true
      where m.venue_id = $1 and m.pin_verifier is not null
      order by u.name`,
    [venueId],
  );
  const findings: PinFinding[] = [];
  for (const p of people.rows) {
    for (const pin of DEMO_PINS) {
      if (await verifyPin(pepper, p.pin_verifier, venueId, p.id, pin)) {
        findings.push({
          name: p.name,
          role: p.role,
          why: "demo_pin",
          detail: "a demo PIN from the seed verifies: send a PIN reset",
        });
        break;
      }
    }
    if (p.action !== "memberships.update" || p.actor !== p.user_id) {
      findings.push({
        name: p.name,
        role: p.role,
        why: "not_set_by_self",
        detail:
          p.action === null
            ? "no audit row shows who set this PIN: send a PIN reset"
            : p.action !== "memberships.update"
              ? "the PIN came in with the record (a seed or an import), not from its own person: send a PIN reset"
              : "someone other than this person set the PIN: send a PIN reset",
      });
    }
  }
  return { checked: people.rows.length, findings, ok: findings.length === 0 };
}

export function pinReport(slug: string, e: PinEvidence): string {
  return [
    `# PIN check · ${slug}`,
    "",
    `${e.checked} PIN(s) checked against the ${DEMO_PINS.length} demo PINs and their audit rows.`,
    "",
    ...(e.ok
      ? ["No demo PIN verifies for anyone, and every PIN was set by its own person."]
      : [
          "| Person | Role | Finding |",
          "| --- | --- | --- |",
          ...e.findings.map((f) => `| ${f.name} | ${f.role} | ${f.detail} |`),
        ]),
    "",
  ].join("\n");
}
