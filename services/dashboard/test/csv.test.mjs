// Run with:  cd services/dashboard && npm test
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  MAX_BYTES, MAX_ROWS, decodeBytes, parseCsv, sniffDelimiter, chooseColumn, normaliseCell,
  buildEntries, readUpload, csvCell, toCsv,
} from "../lib/csv.mjs";

const bytes = (s) => new TextEncoder().encode(s);
const utf16le = (s, bom = true) => {
  const out = new Uint8Array((s.length + (bom ? 1 : 0)) * 2);
  let o = 0;
  if (bom) { out[o++] = 0xff; out[o++] = 0xfe; }
  for (const ch of s) { const c = ch.charCodeAt(0); out[o++] = c & 255; out[o++] = c >> 8; }
  return out;
};

// ---- parsing ---------------------------------------------------------------------------------

test("quotes, embedded commas, embedded line breaks and doubled quotes", () => {
  const { rows } = parseCsv('email,note\r\na@b.com,"has, comma"\r\nc@d.com,"two\nlines"\r\ne@f.com,"say ""hi"""\r\n');
  assert.deepEqual(rows, [
    ["email", "note"], ["a@b.com", "has, comma"], ["c@d.com", "two\nlines"], ["e@f.com", 'say "hi"'],
  ]);
});

test("every kind of line ending, a missing final newline, and blank lines", () => {
  for (const nl of ["\n", "\r\n", "\r"]) {
    const { rows } = parseCsv(`email${nl}a@b.com${nl}${nl}c@d.com`);
    assert.deepEqual(rows, [["email"], ["a@b.com"], ["c@d.com"]]);
  }
});

test("semicolon and tab separated files, and a sep= line", () => {
  assert.equal(parseCsv("email;name\na@b.com;Ann\nc@d.com;Cy").delimiter, ";");
  assert.equal(parseCsv("email\tname\na@b.com\tAnn\nc@d.com\tCy").delimiter, "\t");
  const withSep = parseCsv("sep=;\nemail;name\na@b.com;Ann");
  assert.deepEqual(withSep.rows, [["email", "name"], ["a@b.com", "Ann"]]);
});

test("delimiters inside quotes do not count when sniffing", () => {
  assert.equal(sniffDelimiter('email,name\n"a;b@c.com",x\n"d;e@f.com",y'), ",");
});

test("a single column file has no delimiter and parses as one column", () => {
  assert.deepEqual(parseCsv("a@b.com\nc@d.com\n").rows, [["a@b.com"], ["c@d.com"]]);
});

test("an unterminated quote is reported, not swallowed silently", () => {
  assert.equal(parseCsv('email\n"a@b.com\nc@d.com').error, "unterminated_quote");
});

test("one enormous cell is rejected", () => {
  assert.equal(parseCsv(`email\n${"x".repeat(20000)}`).error, "cell_too_long");
});

test("ragged rows do not crash", () => {
  const { rows } = parseCsv("email,name,plan\na@b.com\nc@d.com,Cy,pro,extra\n");
  assert.equal(rows.length, 3);
});

// ---- bytes -----------------------------------------------------------------------------------

test("UTF-8 with and without a byte order mark", () => {
  assert.equal(decodeBytes(bytes("﻿email\na@b.com")).text.includes("a@b.com"), true);
  assert.equal(parseCsv(decodeBytes(bytes("﻿email\na@b.com")).text).rows[0][0], "email");
});

test("UTF-16 saved by Excel, with and without a mark, little and big endian", () => {
  const text = "email\na@b.com\n";
  assert.equal(decodeBytes(utf16le(text)).text, text);
  assert.equal(decodeBytes(utf16le(text, false)).text, text);
  const be = new Uint8Array([0xfe, 0xff, ...[...text].flatMap((ch) => [0, ch.charCodeAt(0)])]);
  assert.equal(decodeBytes(be).text, text);
});

test("binary files are refused with a helpful message code", () => {
  const xlsxLike = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00, 0x41, 0x42]);
  assert.equal(decodeBytes(xlsxLike).error, "not_text");
  assert.equal(decodeBytes(new Uint8Array(0)).error, "empty");
});

// ---- choosing the column -----------------------------------------------------------------------

test("finds a column by its header, whatever it is called", () => {
  for (const header of ["email", "Email Address", "Work E-mail", "email_address", "EMAIL"]) {
    assert.deepEqual(chooseColumn([["id", header], ["1", "a@b.com"]]), { column: 1, hasHeader: true }, header);
  }
});

test("a first cell that is itself an address is data, not a header", () => {
  assert.deepEqual(chooseColumn([["a@b.com", "Ann"], ["c@d.com", "Cy"]]), { column: 0, hasHeader: false });
});

test("no header: picks the column where most cells are addresses", () => {
  assert.deepEqual(chooseColumn([["1", "Ann", "a@b.com"], ["2", "Cy", "c@d.com"]]), { column: 2, hasHeader: false });
});

test("a single column with an unfamiliar header, or of bare domains", () => {
  assert.deepEqual(chooseColumn([["Customer"], ["a@b.com"]]).hasHeader, true);
  assert.deepEqual(chooseColumn([["gmail.com"], ["mailinator.com"]]), { column: 0, hasHeader: false });
});

test("several columns and no addresses anywhere asks the user to choose", () => {
  assert.equal(chooseColumn([["id", "name"], ["1", "Ann"]]).error, "no_email_column");
});

// ---- cleaning one cell ---------------------------------------------------------------------------

test("tidies the common ways addresses are written", () => {
  assert.equal(normaliseCell("  a@b.com  ").value, "a@b.com");
  assert.equal(normaliseCell('"a@b.com"').value, "a@b.com");
  assert.equal(normaliseCell("mailto:a@b.com").value, "a@b.com");
  assert.equal(normaliseCell("Ann Lee <a@b.com>").value, "a@b.com");
  assert.equal(normaliseCell("a@b.com.").value, "a@b.com");
  assert.equal(normaliseCell("a@b.com;").value, "a@b.com");
  assert.equal(normaliseCell("gmail.com").value, "gmail.com"); // a bare domain is allowed
});

test("says why a cell can't be used", () => {
  assert.equal(normaliseCell("").error, "empty_cell");
  assert.equal(normaliseCell("   ").error, "empty_cell");
  assert.equal(normaliseCell("a@b.com; c@d.com").error, "multiple_addresses");
  assert.equal(normaliseCell("a@b.com, c@d.com").error, "multiple_addresses");
  assert.equal(normaliseCell("a@b.com c@d.com").error, "multiple_addresses");
  assert.equal(normaliseCell("ann lee").error, "has_spaces");
  assert.equal(normaliseCell(`${"a".repeat(330)}@b.com`).error, "too_long");
});

test("internationalised domains are converted to their ASCII form", () => {
  assert.equal(normaliseCell("anna@münchen.de").value, "anna@xn--mnchen-3ya.de");
});

// ---- the list of rows ---------------------------------------------------------------------------

test("duplicates are found ignoring case, and point at the first row", () => {
  const rows = [["email"], ["A@B.com"], ["c@d.com"], ["a@b.COM"], ["nonsense words"], [""]];
  const out = buildEntries(rows, 0, true);
  assert.equal(out.entries[2].duplicateOf, 1);
  assert.deepEqual(out.counts, { total: 5, unique: 2, invalid: 2, duplicates: 1 });
  assert.equal(out.entries[3].error, "has_spaces");
  assert.equal(out.entries[3].raw, "nonsense words"); // unusable rows keep what the cell said
  assert.equal(out.entries[4].raw, "");
});

test("row limits", () => {
  const rows = [["email"], ...Array.from({ length: MAX_ROWS }, (_, i) => [`u${i}@x.com`])];
  assert.equal(buildEntries(rows, 0, true).counts.total, MAX_ROWS);
  assert.equal(buildEntries([...rows, ["extra@x.com"]], 0, true).error, "too_many_rows");
  assert.equal(buildEntries([["email"]], 0, true).error, "no_rows");
});

// ---- the whole file -------------------------------------------------------------------------------

test("a normal file end to end", () => {
  const file = 'id,Email,name\n1,ann@gmail.com,Ann\n2,"cy@mailinator.com",Cy\n3,ann@gmail.com,Ann again\n';
  const out = readUpload(bytes(file));
  assert.equal(out.ok, true);
  assert.equal(out.column, 1);
  assert.equal(out.hasHeader, true);
  assert.deepEqual(out.counts, { total: 3, unique: 2, invalid: 0, duplicates: 1 });
  assert.deepEqual(out.labels, ["id", "Email", "name"]);
});

test("the size limit is checked from the reported size before anything is read", () => {
  assert.equal(readUpload(new Uint8Array(10), MAX_BYTES + 1).error, "too_big");
});

test("files that can't be used give a specific reason", () => {
  assert.equal(readUpload(new Uint8Array(0)).error, "empty");
  assert.equal(readUpload(bytes("   \n\n  \n")).error, "empty");
  assert.equal(readUpload(bytes("email\n")).error, "no_rows");
  assert.equal(readUpload(bytes('email\n"open')).error, "unterminated_quote");
});

test("a file with no recognisable email column still reads, and says the column must be chosen", () => {
  const out = readUpload(bytes("id,name\n1,Ann\n2,Cy\n"));
  assert.equal(out.ok, true);
  assert.equal(out.columnNeedsChoosing, true);
});

// ---- writing a CSV --------------------------------------------------------------------------------

test("cells that a spreadsheet would run as a formula are defused", () => {
  for (const evil of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"]) {
    assert.equal(csvCell(evil).startsWith(`"'`), true, JSON.stringify(evil));
  }
  assert.equal(csvCell("a@b.com"), '"a@b.com"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(0.95), '"0.95"');
});

test("the exported file has a byte order mark, CRLF line ends, and reads back the same", () => {
  const out = toCsv(["email", "note"], [["a@b.com", 'has "quotes", commas'], ["c@d.com", "two\nlines"]]);
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.ok(out.includes("\r\n"));
  const back = parseCsv(out).rows;
  assert.deepEqual(back, [["email", "note"], ["a@b.com", 'has "quotes", commas'], ["c@d.com", "two\nlines"]]);
});

// ---- the sample files shipped with the project ----------------------------------------------------

const SAMPLES = [["emails-1000.csv", 900, 1100], ["emails-75.csv", 50, 100], ["emails-15.csv", 10, 20]];
for (const [name, min, max] of SAMPLES) {
  const path = new URL(`../../../samples/${name}`, import.meta.url);
  test(`sample file ${name} is readable and the right size`, { skip: !existsSync(path) && "sample not generated yet" }, () => {
    const buf = readFileSync(path);
    const out = readUpload(new Uint8Array(buf), buf.length);
    assert.equal(out.ok, true, JSON.stringify(out.error));
    assert.equal(out.columnNeedsChoosing, false);
    assert.ok(out.counts.total >= min && out.counts.total <= max, `rows ${out.counts.total}`);
    assert.ok(buf.length < MAX_BYTES);
  });
}
