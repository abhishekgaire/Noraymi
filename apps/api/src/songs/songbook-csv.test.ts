import { describe, expect, it } from "vitest";
import { parseSongbook, songbookText } from "./songbook-csv.js";

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `Song ${i + 1},Artist ${i + 1},C${i + 1}`);

describe("the songbook CSV (M6-23)", () => {
  it("reads title, artist and code under a header in any order and case", () => {
    const r = parseSongbook(
      "Code,TITLE,Artist,Genre\r\nPB-101,Mr. Brightside,The Killers,Rock\r\n",
    );
    expect(r).toEqual({
      ok: true,
      songs: [{ title: "Mr. Brightside", artist: "The Killers", code: "PB-101" }],
    });
  });

  it("takes quoted commas, doubled quotes and line breaks, a byte-order mark and blank lines", () => {
    const r = parseSongbook(
      '﻿title,artist,code\n\n"Hello, Goodbye",The Beatles,1\n"Say ""Yes""","Line\nBreak",2\n',
    );
    expect(r.ok && r.songs).toEqual([
      { title: "Hello, Goodbye", artist: "The Beatles", code: "1" },
      { title: 'Say "Yes"', artist: "Line Break", code: "2" },
    ]);
  });

  it("an empty artist or code is kept as none", () => {
    const r = parseSongbook("title,artist,code\nValerie,,\n");
    expect(r.ok && r.songs).toEqual([{ title: "Valerie", artist: null, code: null }]);
  });

  it("a missing title on line 12 reports line 12, and every failing row is listed", () => {
    const rows = ["title,artist,code", ...lines(10), ",The Killers,PB-1", `${"x".repeat(121)},A,B`];
    const r = parseSongbook(rows.join("\n"));
    expect(r).toEqual({
      ok: false,
      errors: [
        { line: 12, problem: "missing_title" },
        { line: 13, problem: "title_too_long" },
      ],
    });
  });

  it("counts lines in the file, past a quoted line break", () => {
    const r = parseSongbook('title,artist,code\n"A\nB",X,1\n,Y,2\n');
    expect(r).toEqual({ ok: false, errors: [{ line: 4, problem: "missing_title" }] });
  });

  it("refuses a file without the header, with no songs, or with an open quote", () => {
    expect(parseSongbook("Mr. Brightside,The Killers,1\n")).toEqual({
      ok: false,
      errors: [{ line: 1, problem: "no_header" }],
    });
    expect(parseSongbook("title,artist,code\n")).toEqual({
      ok: false,
      errors: [{ line: 0, problem: "no_songs" }],
    });
    expect(parseSongbook('title,artist,code\n"Open,A,1\n')).toEqual({
      ok: false,
      errors: [{ line: 2, problem: "unclosed_quote" }],
    });
  });

  it("refuses text that isn't UTF-8", () => {
    expect(songbookText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBeNull();
    expect(songbookText(new TextEncoder().encode("café"))).toBe("café");
  });
});
