import {
  Temporal,
  isSettingsKey,
  parseSetting,
  startsNextBusinessDate,
  withLaterPart,
  type SettingsKey,
  type SettingsValue,
} from "@west4/shared";
import { checkSetting, type CheckContext } from "@west4/rules";
import { emitEvent } from "./events.js";
import type { Queryable } from "./tenancy.js";

/** A stored version of one key. */
export interface SettingVersion<K extends SettingsKey = SettingsKey> {
  readonly key: K;
  readonly version: number;
  readonly value: SettingsValue<K>;
  readonly startsOn: string;
  readonly savedAt: string;
  readonly savedBy: string | null;
}

interface Row {
  key: string;
  version: number;
  value: unknown;
  starts_on: string;
  saved_at: Date;
  saved_by: string | null;
}

function toVersion<K extends SettingsKey>(row: Row): SettingVersion<K> {
  return {
    key: row.key as K,
    version: row.version,
    value: row.value as SettingsValue<K>,
    startsOn: row.starts_on,
    savedAt: row.saved_at.toISOString(),
    savedBy: row.saved_by,
  };
}

/** The version in force for a business date: the newest one that has started by then. Inside a venue transaction. */
export async function readSetting<K extends SettingsKey>(
  client: Queryable,
  venueId: string,
  key: K,
  businessDate: Temporal.PlainDate,
): Promise<SettingVersion<K> | null> {
  const r = await client.query<Row>(
    `select key, version, value, starts_on::text, saved_at, saved_by from venue_settings
      where venue_id = $1 and key = $2 and starts_on <= $3::date
      order by version desc limit 1`,
    [venueId, key, businessDate.toString()],
  );
  return r.rows[0] ? toVersion<K>(r.rows[0]) : null;
}

/** Every version of a key, newest first: the change log. */
export async function settingHistory<K extends SettingsKey>(
  client: Queryable,
  venueId: string,
  key: K,
): Promise<SettingVersion<K>[]> {
  const r = await client.query<Row>(
    "select key, version, value, starts_on::text, saved_at, saved_by from venue_settings where venue_id = $1 and key = $2 order by version desc",
    [venueId, key],
  );
  return r.rows.map((row) => toVersion<K>(row));
}

export class SettingsRefused extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(reasons.join(" "));
    this.name = "SettingsRefused";
  }
}

export interface SaveSettingsArgs {
  readonly venueId: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly savedBy: string | undefined;
  /** Today's business date, from the app clock. */
  readonly today: Temporal.PlainDate;
  readonly check: Omit<CheckContext, "today">;
}

/**
 * "Save and publish": validate every key against its schema and the rule
 * pack, write a new version of each in one transaction, and send one
 * settings.changed. Any refusal saves nothing. Inside a venue transaction.
 */
export async function saveSettings(
  client: Queryable,
  args: SaveSettingsArgs,
): Promise<SettingVersion[]> {
  const reasons: string[] = [];
  const parsed: { key: SettingsKey; value: unknown }[] = [];
  for (const [key, raw] of Object.entries(args.values)) {
    if (!isSettingsKey(key)) {
      reasons.push(`${key}: not a settings key`);
      continue;
    }
    const result = parseSetting(key, raw);
    if (!result.ok) {
      reasons.push(...result.reasons);
      continue;
    }
    reasons.push(...checkSetting(key, result.value, { ...args.check, today: args.today }));
    parsed.push({ key, value: result.value });
  }
  if (reasons.length > 0) throw new SettingsRefused(reasons);
  if (parsed.length === 0) throw new SettingsRefused(["nothing to save"]);

  const saved: SettingVersion[] = [];
  const write = async (key: SettingsKey, value: unknown, startsOn: Temporal.PlainDate) => {
    const r = await client.query<Row>(
      `insert into venue_settings (venue_id, key, version, value, saved_by, starts_on)
       select $1, $2, coalesce(max(version), 0) + 1, $3, $4, $5 from venue_settings where venue_id = $1 and key = $2
       returning key, version, value, starts_on::text, saved_at, saved_by`,
      [args.venueId, key, JSON.stringify(value), args.savedBy ?? null, startsOn.toString()],
    );
    saved.push(toVersion(r.rows[0]!));
  };
  for (const { key, value } of parsed) {
    const inForce = await readSetting(client, args.venueId, key, args.today);
    // A version saved earlier that starts at a later business date (a layout published tonight).
    const waiting = (
      await client.query<Row>(
        `select key, version, value, starts_on::text, saved_at, saved_by from venue_settings
          where venue_id = $1 and key = $2 and starts_on > $3::date order by version desc limit 1`,
        [args.venueId, key, args.today.toString()],
      )
    ).rows[0];
    if (startsNextBusinessDate(key, inForce?.value, value)) {
      // The parts that are live at once still start tonight (M6-25); the rest waits.
      const tonight = withLaterPart(key, value, inForce!.value);
      if (canonical(tonight) !== canonical(inForce!.value)) await write(key, tonight, args.today);
      await write(key, value, args.today.add({ days: 1 }));
    } else {
      await write(key, value, args.today);
      // Keep what was already waiting for its date, with tonight's change in it too.
      if (waiting && waiting.version > (inForce?.version ?? 0))
        await write(
          key,
          withLaterPart(key, value, waiting.value),
          Temporal.PlainDate.from(waiting.starts_on),
        );
    }
  }
  await emitEvent(client, {
    venueId: args.venueId,
    type: "settings.changed",
    entityId: parsed.map((p) => p.key).join(","),
    entityVersion: Math.max(...saved.map((s) => s.version)),
  });
  return saved;
}

/** JSON with its keys sorted: a jsonb value read back compares equal to the one that was sent. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
