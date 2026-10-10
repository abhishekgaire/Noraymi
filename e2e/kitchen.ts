import type pg from "pg";

/**
 * The test-only kitchen menu (K-04), laid over the demo seed for a test and taken off after it:
 * West 4 has no kitchen, and no venue's real menu is used. Two food categories, TEST Wings then
 * TEST Sides, with Kitchen & food allowed and on. `restore` puts the module back as it was (off in
 * the seed, which hides the food from every menu) and puts the categories' names and order back.
 */
export async function testKitchenMenu(
  db: pg.Client,
  options: { choices?: boolean } = {},
): Promise<{ restore: () => Promise<void> }> {
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
    if (found.rowCount) {
      await db.query("update menu_items set shown = true where venue_id = $1 and name = $2", [
        venue,
        name,
      ]);
      return (
        await db.query<{ id: string }>(
          "select id from menu_items where venue_id = $1 and name = $2",
          [venue, name],
        )
      ).rows[0]!.id;
    }
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
    return id;
  };
  const was = (
    await db.query<{ allowed: boolean; state: string }>(
      "select allowed, state from venue_modules where venue_id = $1 and module_id = 'kitchen'",
      [venue],
    )
  ).rows[0]!;
  const wingsCat = await category("TEST Wings", 900);
  const sidesCat = await category("TEST Sides", 910);
  await item(wingsCat, "TEST wings", 1200);
  await item(sidesCat, "TEST side", 500);
  // The bar POS's food (K-05): TEST French Fries, and TEST chicken wings with a required sauce and
  // an optional meal. Hidden again by restore, so other tests' menus don't change.
  const extra = ["TEST French Fries", "TEST chicken wings"];
  if (options.choices) {
    await item(sidesCat, "TEST French Fries", 500);
    const chicken = await item(wingsCat, "TEST chicken wings", 1099);
    const groups = await db.query("select 1 from modifier_groups where item_id = $1", [chicken]);
    if (!groups.rowCount) {
      const group = async (name: string, required: boolean) =>
        (
          await db.query<{ id: string }>(
            "insert into modifier_groups (venue_id, item_id, name, required, min_choices) values ($1, $2, $3, $4, $5) returning id",
            [venue, chicken, name, required, required ? 1 : 0],
          )
        ).rows[0]!.id;
      const sauce = await group("TEST sauce", true);
      for (const name of ["TEST soy garlic", "TEST ranch"])
        await db.query(
          "insert into menu_options (venue_id, item_id, group_id, name) values ($1, $2, $3, $4)",
          [venue, chicken, sauce, name],
        );
      const meal = await group("TEST meal", false);
      await db.query(
        "insert into menu_options (venue_id, item_id, group_id, name, price_delta_cents) values ($1, $2, $3, 'TEST make it a meal', 500)",
        [venue, chicken, meal],
      );
    }
  }
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
      await db.query(
        "update menu_items set shown = false where venue_id = $1 and name = any($2::text[])",
        [venue, extra],
      );
      await category("TEST Wings", 900);
      await category("TEST Sides", 910);
    },
  };
}
