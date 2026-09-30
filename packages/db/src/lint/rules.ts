import {
  APPEND_ONLY_TABLES,
  APP_ROLE,
  AUDITED_MIGRATION_ROLE,
  MONEY_TABLES,
  TENANCY_ROOT_TABLES,
  isMoneyColumn,
} from "./config.js";
import { columnList, parenBody, splitStatements, splitTopLevel, tableName } from "./sql.js";
import type { Statement } from "./sql.js";

export type RuleId =
  | "lock-timeout"
  | "index-concurrently"
  | "append-only-nullable"
  | "money-rows-immutable"
  | "venue-table-rls"
  | "fk-names-venue"
  | "app-rw-grants"
  | "backfill-role";

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: RuleId;
  readonly message: string;
}

/** What earlier migrations established: which tables are venue-owned. */
export interface Catalog {
  readonly venueTables: Set<string>;
}

export function emptyCatalog(): Catalog {
  return { venueTables: new Set() };
}

interface TableState {
  createdHere: boolean;
  hasVenueId: boolean;
  hasId: boolean;
  rlsEnabled: boolean;
  rlsForced: boolean;
  policy: boolean;
  uniqueVenueId: boolean;
  /** Line where venue_id first appeared in this file, for the finding. */
  line: number;
}

/**
 * Lint one migration. The catalog is updated with the venue tables this file
 * creates, so later files can be checked against them.
 */
export function lintMigration(file: string, source: string, catalog: Catalog): Finding[] {
  const findings: Finding[] = [];
  const statements = splitStatements(source);
  const tables = new Map<string, TableState>();
  const fail = (line: number, rule: RuleId, message: string): void => {
    findings.push({ file, line, rule, message });
  };

  const state = (name: string, line: number): TableState => {
    let t = tables.get(name);
    if (!t) {
      t = {
        createdHere: false,
        hasVenueId: false,
        hasId: false,
        rlsEnabled: false,
        rlsForced: false,
        policy: false,
        uniqueVenueId: false,
        line,
      };
      tables.set(name, t);
    }
    return t;
  };

  const isVenueOwned = (name: string): boolean =>
    catalog.venueTables.has(name) || tables.get(name)?.hasVenueId === true;

  // Rule: lock_timeout must be set before the first statement that isn't a SET.
  const firstReal = statements.find((s) => !/^(set|reset|begin|start transaction)\b/.test(s.text));
  const lockTimeout = statements.find((s) => /^set (local )?lock_timeout\b/.test(s.text));
  if (firstReal && (!lockTimeout || lockTimeout.line > firstReal.line)) {
    fail(firstReal.line, "lock-timeout", "set lock_timeout before the first statement");
  }

  let asAuditedRole = false;

  for (const statement of statements) {
    const { text, line } = statement;
    let m: RegExpExecArray | null;

    // set role / reset role
    if ((m = /^set (local |session )?role (\S+)$/.exec(text))) {
      asAuditedRole = tableName(m[2]!) === AUDITED_MIGRATION_ROLE;
      continue;
    }
    if (/^reset role$/.test(text) || /^set (local |session )?role none$/.test(text)) {
      asAuditedRole = false;
      continue;
    }

    // create table
    if (
      (m = /^create (?:unlogged |temp(?:orary)? )?table (?:if not exists )?([\w."]+)/.exec(text))
    ) {
      const name = tableName(m[1]!);
      const t = state(name, line);
      t.createdHere = true;
      const body = parenBody(text, m[0].length);
      if (body) {
        for (const part of splitTopLevel(body.body)) {
          checkTableElement(name, part, line, t);
        }
      }
      continue;
    }

    // alter table
    if ((m = /^alter table (?:if exists )?(?:only )?([\w."]+) (.*)$/.exec(text))) {
      const name = tableName(m[1]!);
      const rest = m[2]!;
      const t = state(name, line);
      for (const action of splitTopLevel(rest)) {
        let a: RegExpExecArray | null;
        if (/^enable row level security$/.test(action)) t.rlsEnabled = true;
        else if (/^force row level security$/.test(action)) t.rlsForced = true;
        else if ((a = /^add (?:column )?(?:if not exists )?(.*)$/.exec(action))) {
          const element = a[1]!;
          if (/^(constraint |unique|primary key|foreign key|check|exclude)/.test(element)) {
            checkTableElement(name, element, line, t);
          } else {
            checkColumn(name, element, line, t);
            if (
              APPEND_ONLY_TABLES.has(name) &&
              !t.createdHere &&
              /\bnot null\b/.test(element) &&
              !/\bgenerated\b/.test(element)
            ) {
              fail(
                line,
                "append-only-nullable",
                `${name} is append-only; a new column must be nullable`,
              );
            }
          }
        }
      }
      continue;
    }

    // create policy venue_isolation on <table>
    if ((m = /^create policy ([\w"]+) on ([\w."]+)/.exec(text))) {
      if (tableName(m[1]!) === "venue_isolation") state(tableName(m[2]!), line).policy = true;
      continue;
    }

    // create index
    if (
      (m =
        /^create (?:unique )?index (concurrently )?(?:if not exists )?[\w"]* ?on (?:only )?([\w."]+)/.exec(
          text,
        ))
    ) {
      const name = tableName(m[2]!);
      if (!m[1] && !tables.get(name)?.createdHere) {
        fail(
          line,
          "index-concurrently",
          `an index on the existing table ${name} must use create index concurrently`,
        );
      }
      continue;
    }

    // grant
    if ((m = /^grant (.+?) on (?:table )?(.+?) to (.+)$/.exec(text))) {
      const grantees = m[3]!.split(",").map((g) => tableName(g.trim()));
      if (grantees.includes(APP_ROLE)) {
        const targets = m[2]!.split(",").map((x) => tableName(x.trim()));
        for (const priv of splitTopLevel(m[1]!)) {
          const kind = priv.replace(/\s*\(.*$/, "").trim();
          if (
            ["delete", "truncate", "references", "trigger", "all", "all privileges"].includes(kind)
          ) {
            fail(
              line,
              "app-rw-grants",
              `${APP_ROLE} never gets ${kind} (on ${targets.join(", ")})`,
            );
          } else if (kind === "update") {
            const cols = parenBody(priv);
            for (const target of targets) {
              if (!MONEY_TABLES.has(target)) continue;
              if (!cols) {
                fail(
                  line,
                  "app-rw-grants",
                  `${APP_ROLE} may only update named non-money columns of ${target}`,
                );
                continue;
              }
              for (const col of columnList(cols.body)) {
                if (isMoneyColumn(col)) {
                  fail(line, "app-rw-grants", `${APP_ROLE} never gets update on ${target}.${col}`);
                }
              }
            }
          }
        }
      }
      continue;
    }

    // data statements: update, delete, insert
    if ((m = /^(update|delete from|insert into) (?:only )?([\w."]+)/.exec(text))) {
      const verb = m[1]!;
      const name = tableName(m[2]!);
      if (verb !== "insert into" && MONEY_TABLES.has(name)) {
        fail(
          line,
          "money-rows-immutable",
          `a migration never ${verb.split(" ")[0]}s money rows (${name})`,
        );
        continue;
      }
      if (!tables.get(name)?.createdHere && !asAuditedRole) {
        fail(
          line,
          "backfill-role",
          `a backfill of ${name} must run as ${AUDITED_MIGRATION_ROLE} (set role ${AUDITED_MIGRATION_ROLE})`,
        );
      }
      continue;
    }
  }

  // Rule: every table that gained venue_id in this file has the full wall.
  for (const [name, t] of tables) {
    if (!t.hasVenueId) continue;
    if (!t.createdHere && !catalog.venueTables.has(name) && !t.hasVenueId) continue;
    const missing: string[] = [];
    if (!t.rlsEnabled) missing.push("enable row level security");
    if (!t.rlsForced) missing.push("force row level security");
    if (!t.policy) missing.push("the venue_isolation policy");
    if (t.hasId && !t.uniqueVenueId) missing.push("unique (venue_id, id)");
    if (missing.length > 0) {
      fail(t.line, "venue-table-rls", `${name} has venue_id but lacks ${missing.join(", ")}`);
    }
    catalog.venueTables.add(name);
  }

  return findings.sort((a, b) => a.line - b.line);

  function checkColumn(table: string, element: string, line: number, t: TableState): void {
    const column = element.split(/\s+/)[0]!.replace(/"/g, "");
    if (column === "venue_id") {
      t.hasVenueId = true;
      if (!t.createdHere) t.line = line;
    }
    if (column === "id") t.hasId = true;
    const ref = /\breferences ([\w."]+)\s*(\([^)]*\))?/.exec(element);
    if (ref) checkReference(table, [column], ref[1]!, ref[2], line);
  }

  function checkTableElement(table: string, element: string, line: number, t: TableState): void {
    const e = element.replace(/^constraint [\w"]+ /, "");
    let m: RegExpExecArray | null;
    if ((m = /^(unique|primary key) \(([^)]*)\)/.exec(e))) {
      const cols = columnList(m[2]!);
      if (cols.length === 2 && cols[0] === "venue_id" && cols[1] === "id") t.uniqueVenueId = true;
      return;
    }
    if ((m = /^foreign key \(([^)]*)\) references ([\w."]+)\s*(\([^)]*\))?/.exec(e))) {
      checkReference(table, columnList(m[1]!), m[2]!, m[3], line);
      return;
    }
    if (/^(check|exclude)\b/.test(e)) return;
    checkColumn(table, e, line, t);
  }

  function checkReference(
    table: string,
    localColumns: string[],
    targetRaw: string,
    targetColumns: string | undefined,
    line: number,
  ): void {
    const target = tableName(targetRaw);
    if (TENANCY_ROOT_TABLES.has(target) || !isVenueOwned(target)) return;
    const cols = targetColumns ? columnList(targetColumns.slice(1, -1)) : [];
    if (!cols.includes("venue_id") || !localColumns.includes("venue_id")) {
      fail(
        line,
        "fk-names-venue",
        `${table} → ${target}: a foreign key to a venue table must name venue_id, ` +
          `for example references ${target} (venue_id, id)`,
      );
    }
  }
}

export { splitStatements };
export type { Statement };
