import type pg from "pg";

/**
 * Local demo only: removes a demo venue made after the seed (`singsing`, by
 * scripts/demo-sing-sing.mjs or the `--onboard` path), with its people, so the
 * next run starts clean. Replica mode skips the foreign-key and audit
 * triggers, so every table with a venue_id loses the venue's rows in any
 * order. The venue's organization goes too when no other venue shares it
 * (the `--sing-sing` shortcut puts Sing Sing under West 4's, which stays).
 * The users go by their email domain. Run as the table owner, on a local
 * database; the caller checks that.
 */
export async function removeLocalDemoVenue(
  client: pg.ClientBase,
  input: { readonly slug: string; readonly emailDomain: string },
): Promise<{ removedVenue: boolean; removedOrg: boolean; removedUsers: number }> {
  const columnTables = async (column: string, without: string | null) =>
    (
      await client.query<{ relname: string }>(
        `select c.relname from pg_class c
           join pg_attribute a on a.attrelid = c.oid and a.attname = $1 and not a.attisdropped
          where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace
            and ($2::text is null or not exists (
              select 1 from pg_attribute b where b.attrelid = c.oid and b.attname = $2 and not b.attisdropped))`,
        [column, without],
      )
    ).rows.map((r) => r.relname);
  await client.query("begin");
  try {
    await client.query("set local session_replication_role = replica");
    const old = (
      await client.query<{ id: string; org_id: string }>(
        "select id, org_id from venues where slug = $1",
        [input.slug],
      )
    ).rows[0];
    const oldUsers = (
      await client.query<{ id: string }>("select id from users where email like $1", [
        `%@${input.emailDomain}`,
      ])
    ).rows.map((r) => r.id);
    let removedOrg = false;
    if (old) {
      for (const t of await columnTables("device_id", "venue_id"))
        await client.query(
          `delete from "${t}" where device_id in (select id from devices where venue_id = $1)`,
          [old.id],
        );
      for (const t of await columnTables("venue_id", null))
        await client.query(`delete from "${t}" where venue_id = $1`, [old.id]);
      await client.query("delete from venues where id = $1", [old.id]);
      const shared = await client.query("select 1 from venues where org_id = $1 limit 1", [
        old.org_id,
      ]);
      if (shared.rowCount === 0) {
        for (const t of await columnTables("org_id", "venue_id"))
          if (t !== "organizations")
            await client.query(`delete from "${t}" where org_id = $1`, [old.org_id]);
        await client.query("delete from organizations where id = $1", [old.org_id]);
        removedOrg = true;
      }
    }
    if (oldUsers.length > 0) {
      for (const t of await columnTables("user_id", "venue_id"))
        await client.query(`delete from "${t}" where user_id = any($1::uuid[])`, [oldUsers]);
      await client.query("delete from users where id = any($1::uuid[])", [oldUsers]);
    }
    await client.query("commit");
    return { removedVenue: Boolean(old), removedOrg, removedUsers: oldUsers.length };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}
