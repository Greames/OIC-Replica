import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "./csv";

describe("csv", () => {
  it("parses quotes, escapes, newlines in cells, CRLF and a BOM", () => {
    expect(parseCsv('﻿shop,erp\r\nUS,"United, States"\r\n"say ""hi""","two\nlines"\r\n\r\n')).toEqual([
      ["shop", "erp"],
      ["US", "United, States"],
      ['say "hi"', "two\nlines"],
    ]);
  });

  it("guesses ; and tab separators", () => {
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("round-trips", () => {
    const rows = [
      ["a", "b, c"],
      ['q"uote', " pad "],
      ["", "x"],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});
