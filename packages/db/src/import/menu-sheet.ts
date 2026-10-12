import { basename } from "node:path";
import { parseCsv } from "./csv.js";
import { checkMapping, FIELDS, MAPPING_VERSION, type Kind, type Mapping } from "./mapping.js";
import { prepareImport, type Prepared } from "./prepare.js";

/**
 * The owner's menu spreadsheet in Set up your venue's step 8 (O-10; spec 17 · Step details 8):
 * the importer's menu format (M9-04), checked by the importer itself. The owner uploads either
 * a mapping file with the CSVs it names (as our team would run it), or CSVs whose column names
 * are the importer's own fields (`legacy_ref`, `name`, `category`, `price`, …): a file with a
 * `group` column is the menu's choices, any other the menu lines. Only the menu kinds come in
 * this way; guests, bookings, people and the rest stay with our team's import.
 */
export const MENU_SHEET_KINDS: readonly Kind[] = ["menu", "modifiers", "packages"];

export interface SheetFile {
  readonly name: string;
  readonly text: string;
}

export type MenuSheet =
  | { readonly prepared: Prepared; readonly problems: readonly [] }
  | { readonly prepared: null; readonly problems: readonly string[] };

export function prepareMenuSheet(files: readonly SheetFile[], timeZone: string): MenuSheet {
  const byName = new Map(files.map((f) => [basename(f.name).toLowerCase(), f.text]));
  const json = files.filter((f) => f.name.toLowerCase().endsWith(".json"));
  let mapping: Mapping;
  if (json.length > 1) return { prepared: null, problems: ["send one mapping file, not several"] };
  if (json.length === 1) {
    let raw: unknown;
    try {
      raw = JSON.parse(json[0]!.text);
    } catch {
      return { prepared: null, problems: [`${json[0]!.name} isn't a JSON file`] };
    }
    const checked = checkMapping(raw);
    if (!checked.mapping) return { prepared: null, problems: checked.problems };
    mapping = checked.mapping;
    const other = Object.keys(mapping.files).filter((k) => !MENU_SHEET_KINDS.includes(k as Kind));
    if (other.length > 0)
      return {
        prepared: null,
        problems: [`only the menu comes in here; our team imports ${other.join(", ")}`],
      };
    const missing = Object.values(mapping.files)
      .map((f) => f!.file)
      .filter((f) => !byName.has(basename(f).toLowerCase()));
    if (missing.length > 0)
      return { prepared: null, problems: missing.map((f) => `the mapping names ${f}: add it too`) };
  } else {
    const filesByKind: Partial<Record<Kind, { file: string; columns: Record<string, string> }>> =
      {};
    for (const f of files) {
      let header: readonly string[];
      try {
        header = parseCsv(f.text).header.map((h) => h.trim());
      } catch {
        return { prepared: null, problems: [`${f.name} isn't a CSV file`] };
      }
      const kind: Kind = header.includes("group") ? "modifiers" : "menu";
      if (filesByKind[kind])
        return { prepared: null, problems: [`two files look like the ${kind}; send one of each`] };
      const known = [...FIELDS[kind].required, ...FIELDS[kind].optional];
      filesByKind[kind] = {
        file: f.name,
        columns: Object.fromEntries(known.filter((k) => header.includes(k)).map((k) => [k, k])),
      };
    }
    if (!filesByKind.menu)
      return { prepared: null, problems: ["add the menu lines' file (one row per thing sold)"] };
    const checked = checkMapping({
      mapping_version: MAPPING_VERSION,
      source: "setup-menu",
      files: Object.fromEntries(
        Object.entries(filesByKind).map(([k, v]) => [k, { ...v, money_unit: "dollars" }]),
      ),
    });
    if (!checked.mapping) return { prepared: null, problems: checked.problems };
    mapping = checked.mapping;
  }
  const prepared = prepareImport(
    mapping,
    (file) => {
      const text = byName.get(basename(file).toLowerCase());
      if (text === undefined) throw new Error(`the mapping names ${file}: add it too`);
      return text;
    },
    timeZone,
  );
  return { prepared, problems: [] };
}
