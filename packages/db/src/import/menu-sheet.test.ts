import { describe, expect, it } from "vitest";
import { prepareMenuSheet } from "./menu-sheet.js";
import { menuOpenPoints } from "./open-points.js";

const TZ = "America/New_York";
const MENU = "legacy_ref,item_ref,name,category,variant,price,alcohol,tax_category\n";

describe("the owner's menu spreadsheet (O-10)", () => {
  it("reads CSVs in the importer's own columns: the menu lines and, with a group column, the choices", () => {
    const sheet = prepareMenuSheet(
      [
        {
          name: "menu.csv",
          text:
            MENU +
            "B1-BTL,B1,House Lager,Beer,Bottle,$7.25,Y,drink\n" +
            "B1-DFT,B1,House Lager,Beer,Draft,$9.32,Y,drink\n" +
            "S1-SHOT,S1,Rye,Liquor,Shot,$9.00,Y,drink\n" +
            "W1,W1,Wings,Wings,Regular,$12.00,N,food\n" +
            "F1,F1,Fries,Sides,Regular,$5.00,N,food\n",
        },
        {
          name: "choices.csv",
          text:
            "legacy_ref,item_ref,group,name,required,min_choices,max_choices,included,component\n" +
            "W1-S1,W1,Sauce,Honey,Y,1,1,1,\n" +
            "W1-SIDE,W1,Side,Fries,Y,1,1,1,F1\n",
        },
      ],
      TZ,
    );
    expect(sheet.problems).toEqual([]);
    expect(sheet.prepared?.menu).toHaveLength(5);
    expect(sheet.prepared?.modifiers).toHaveLength(2);
    expect(menuOpenPoints(sheet.prepared!)).toEqual([
      { kind: "extra_price", item: "Wings", group: "Sauce" },
      { kind: "extra_price", item: "Wings", group: "Side" },
      { kind: "included_choice", item: "Wings", group: "Side" },
      { kind: "draft", item: "House Lager", group: null },
      { kind: "pour", item: "Rye", group: null },
    ]);
  });

  it("refuses what isn't a menu: no menu lines, other kinds in a mapping, a file it doesn't have", () => {
    expect(
      prepareMenuSheet([{ name: "c.csv", text: "legacy_ref,item_ref,group,name\n" }], TZ),
    ).toMatchObject({ prepared: null });
    const guests = JSON.stringify({
      mapping_version: 1,
      source: "old",
      files: { guests: { file: "g.csv", columns: { legacy_ref: "id", name: "name" } } },
    });
    expect(prepareMenuSheet([{ name: "m.json", text: guests }], TZ).problems[0]).toMatch(
      /our team imports guests/,
    );
    const menu = JSON.stringify({
      mapping_version: 1,
      source: "old",
      files: {
        menu: {
          file: "items.csv",
          columns: Object.fromEntries(
            ["legacy_ref", "name", "category", "price", "alcohol", "tax_category"].map((k) => [
              k,
              k,
            ]),
          ),
        },
      },
    });
    expect(prepareMenuSheet([{ name: "m.json", text: menu }], TZ).problems).toEqual([
      "the mapping names items.csv: add it too",
    ]);
  });
});
