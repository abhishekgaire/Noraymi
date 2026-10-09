import type pg from "pg";

/**
 * The test-only kitchen menu (K-04), laid over the demo seed for a test and taken off after it:
 * West 4 has no kitchen, and no venue's real menu is used. Two food categories, TEST Wings then
 * TEST Sides, with Kitchen & food allowed and on. `restore` puts the module back as it was (off in
 * the seed, which hides the food from every menu) and puts the categories' names and order back.
 */
export async function testKitchenMenu(db: pg.Client): Promise<{ restore: () => Promise<void> }> {
  const venue = (
    await db.query<{ id: string }>("select id from venues where slug = 'west4karaoke'")
  ).rows[0]!.id;
  const category = async (name: string, sort: number) => {
    const found = await db.query<{ id: string }>(
      "select id from menu_categories where venue_id = $1 and name like $2 || '%'",
      [venue, name],
    );
    if (found.rows[0]) {
      await db.query("update menu_categories set name = $2, sort = $3 where id = $1", [
        found.rows[0].id,
        name,
        sort,
      ]);
      return found.rows[0].id;
    }
    return (
      await db.query<{ id: string }>(
        "insert into menu_categories (venue_id, name, sort, tax_category) values ($1, $2, $3, 'food') returning id",
        [venue, name, sort],
      )
    ).rows[0]!.id;
  };
  const item = async (cat: string, name: string, cents: number) => {
    const found = await db.query("select 1 from menu_items where venue_id = $1 and name = $2", [
      venue,
      name,
    ]);
    if (found.rowCount) return;
    const id = (
      await db.query<{ id: string }>(
        "insert into menu_items (venue_id, category_id, name, station) values ($1, $2, $3, 'kitchen') returning id",
        [venue, cat, name],
      )
    ).rows[0]!.id;
    await db.query(
      "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Regular', $3)",
      [venue, id, cents],
    );
  };
  const was = (
    await db.query<{ allowed: boolean; state: string }>(
      "select allowed, state from venue_modules where venue_id = $1 and module_id = 'kitchen'",
      [venue],
    )
  ).rows[0]!;
  await item(await category("TEST Wings", 900), "TEST wings", 1200);
  await item(await category("TEST Sides", 910), "TEST side", 500);
  await db.query(
    "update venue_modules set allowed = true, state = 'on' where venue_id = $1 and module_id = 'kitchen'",
    [venue],
  );
  return {
    restore: async () => {
      await db.query(
        "update venue_modules set allowed = $2, state = $3 where venue_id = $1 and module_id = 'kitchen'",
        [venue, was.allowed, was.state],
      );
      await category("TEST Wings", 900);
      await category("TEST Sides", 910);
    },
  };
}
