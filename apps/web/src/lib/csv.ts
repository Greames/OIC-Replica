// RFC 4180 CSV, for lookup import and export. Quotes, "" escapes, commas and
// newlines inside quoted cells, CRLF, a leading BOM, and ; or tab separators
// (guessed from the first line) are handled.

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = [",", ";", "\t"].reduce((best, s) => (count(firstLine, s) > count(firstLine, best) ? s : best), ",");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

const cell = (v: string) => (/[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(rows: string[][]): string {
  return `${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}
