import { describe, expect, it } from "vitest";
import { splitStatements, splitTopLevel } from "./sql.js";

describe("splitStatements", () => {
  it("drops comments, keeps line numbers and lower-cases", () => {
    const sql = `-- a comment
SET lock_timeout = '5s';

/* block
   comment */ CREATE TABLE T (id int); -- trailing
create policy p on t using (x = 'a;b');`;
    expect(splitStatements(sql)).toEqual([
      { text: "set lock_timeout = '5s'", line: 2 },
      { text: "create table t (id int)", line: 5 },
      { text: "create policy p on t using (x = 'a;b')", line: 6 },
    ]);
  });

  it("keeps semicolons inside dollar quotes and quoted identifiers", () => {
    const sql = `create function f() returns void as $$ begin; end $$ language plpgsql;\nselect ";"`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]?.text).toContain("$$ begin; end $$");
    expect(out[1]?.line).toBe(2);
  });
});

describe("splitTopLevel", () => {
  it("splits at commas outside parentheses", () => {
    expect(splitTopLevel("a int, unique (venue_id, id), b text")).toEqual([
      "a int",
      "unique (venue_id, id)",
      "b text",
    ]);
  });
});
