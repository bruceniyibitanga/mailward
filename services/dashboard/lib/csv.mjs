// Reading and writing CSV files for the bulk check page. No dependencies, so it runs both in the
// browser and under `node --test`.
//
// What it protects against: files that are too big or not text, UTF-16 files saved by Excel,
// quotes and line breaks inside cells, semicolon or tab separated files, files with or without
// a header, addresses written as `Name <a@b.com>` or `mailto:a@b.com`, duplicate rows, and
// spreadsheet formulas in the file we hand back (CSV injection).

export const MAX_BYTES = 1_000_000;   // 1 MB
export const MAX_ROWS = 2000;         // data rows, not counting the header
export const MAX_EMAIL_LENGTH = 320;  // longest valid email address
const MAX_CELL = 10_000;              // stops one unterminated quote swallowing the whole file

/** Messages for each problem, so the page and the tests agree on the wording. */
export const MESSAGES = {
  too_big: "That file is larger than 1 MB. Split it into smaller files.",
  not_text: "That doesn't look like a text file. In Excel, choose Save As, then CSV UTF-8.",
  empty: "The file is empty.",
  no_rows: "The file has a header but no rows below it.",
  too_many_rows: "That file has more than 2,000 rows. Split it into smaller files.",
  no_email_column: "Couldn't find a column of email addresses. Choose the column below.",
  unterminated_quote: "The file has a quote that never closes, so it can't be read reliably. Check the file and try again.",
  cell_too_long: "One cell in the file is unreasonably long, so it can't be read reliably.",
  // per-row problems
  empty_cell: "No email address in this row",
  multiple_addresses: "More than one address in one cell",
  too_long: "Longer than any valid email address",
  has_spaces: "Contains spaces",
  bad_domain: "The domain isn't valid",
};

// ---------------------------------------------------------------------------------------------
// Bytes to text
// ---------------------------------------------------------------------------------------------

/**
 * @param {ArrayBuffer | Uint8Array} input
 * @returns {{ text: string } | { error: "not_text" | "empty" }}
 */
export function decodeBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) return { error: "empty" };

  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)) };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)) };

  // UTF-16 without a mark: text with a zero byte in every other position.
  const sample = bytes.subarray(0, Math.min(bytes.length, 2000));
  let zerosEven = 0;
  let zerosOdd = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) { if (i % 2 === 0) zerosEven++; else zerosOdd++; }
  }
  const pairs = sample.length / 2;
  if (zerosOdd > pairs * 0.3 && zerosEven === 0) return { text: new TextDecoder("utf-16le").decode(bytes) };
  if (zerosEven > pairs * 0.3 && zerosOdd === 0) return { text: new TextDecoder("utf-16be").decode(bytes) };

  // Any other zero byte means a binary file (for example an .xlsx renamed to .csv).
  if (zerosEven + zerosOdd > 0) return { error: "not_text" };

  return { text: new TextDecoder("utf-8").decode(bytes) };
}

// ---------------------------------------------------------------------------------------------
// Text to rows
// ---------------------------------------------------------------------------------------------

function countFields(line, delimiter) {
  let count = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === delimiter && !inQuotes) count++;
  }
  return count;
}

/** Picks comma, semicolon or tab by which one splits the first lines consistently. */
export function sniffDelimiter(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim() !== "").slice(0, 10);
  let best = ",";
  let bestScore = 0;
  for (const candidate of [",", ";", "\t"]) {
    const counts = lines.map((l) => countFields(l, candidate));
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)] ?? 1;
    const agree = counts.filter((c) => c === mode).length / (counts.length || 1);
    const score = mode > 1 && agree >= 0.6 ? mode * agree : 0;
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  return best;
}

/**
 * @param {string} text
 * @returns {{ rows: string[][], delimiter: string, error?: string }}
 */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // Excel in some regions writes "sep=;" as the first line.
  let delimiter;
  const hint = /^sep=(.)\r?\n/i.exec(text);
  if (hint) { delimiter = hint[1]; text = text.slice(hint[0].length); }
  delimiter ??= sniffDelimiter(text);

  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  let atStart = true;

  const endRow = () => {
    row.push(cell);
    cell = "";
    atStart = true;
    if (row.some((c) => c.trim() !== "")) rows.push(row); // blank lines are skipped
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && atStart && cell === "") {
      inQuotes = true;
      atStart = false;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
      atStart = true;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      cell += ch;
      atStart = false;
    }
    if (cell.length > MAX_CELL) return { rows, delimiter, error: "cell_too_long" };
  }
  if (inQuotes) return { rows, delimiter, error: "unterminated_quote" };
  if (cell !== "" || row.length > 0) endRow();
  return { rows, delimiter };
}

// ---------------------------------------------------------------------------------------------
// Rows to a list of addresses
// ---------------------------------------------------------------------------------------------

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+$/;
const DOMAIN_LIKE = /^[^\s@]+\.[A-Za-z]{2,}$/;
const looksCheckable = (v) => EMAIL_LIKE.test(v.trim()) || DOMAIN_LIKE.test(v.trim());

/**
 * Finds the column holding the addresses.
 * @param {string[][]} rows
 * @returns {{ column: number, hasHeader: boolean } | { error: "no_email_column" }}
 */
export function chooseColumn(rows) {
  const width = Math.max(...rows.map((r) => r.length));
  const first = rows[0];

  const named = first.findIndex((c) => /e-?mail/i.test(c) && !EMAIL_LIKE.test(c.trim()));
  if (named !== -1) return { column: named, hasHeader: true };

  // No obvious header: take the column where the most cells look like addresses.
  const sample = rows.slice(0, 50);
  let best = -1;
  let bestRatio = 0;
  for (let c = 0; c < width; c++) {
    const hits = sample.filter((r) => EMAIL_LIKE.test((r[c] ?? "").trim())).length;
    const ratio = hits / sample.length;
    if (ratio > bestRatio) { best = c; bestRatio = ratio; }
  }
  if (best !== -1 && bestRatio >= 0.5) {
    return { column: best, hasHeader: !looksCheckable(first[best] ?? "") };
  }

  // A single column of bare domains, or a single column with a header we don't recognise.
  if (width === 1) return { column: 0, hasHeader: !looksCheckable(first[0] ?? "") };
  return { error: "no_email_column" };
}

/**
 * Cleans one cell into an address to check, or says why it can't be one.
 * @param {string} raw
 * @returns {{ value: string } | { error: keyof typeof MESSAGES }}
 */
export function normaliseCell(raw) {
  let v = String(raw ?? "").trim();
  v = v.replace(/^["'`]+|["'`]+$/g, "");

  const angle = /<([^<>]+)>/.exec(v); // Name <a@b.com>
  if (angle) v = angle[1].trim();
  v = v.replace(/^mailto:/i, "").trim();
  v = v.replace(/[.,;:]+$/, "");

  if (v === "") return { error: "empty_cell" };
  if (v.length > MAX_EMAIL_LENGTH) return { error: "too_long" };
  if ((v.match(/@/g) ?? []).length > 1) return { error: "multiple_addresses" };
  if (/\s/.test(v)) return { error: /[;,]/.test(v) ? "multiple_addresses" : "has_spaces" };

  // Internationalised domain names are sent in their ASCII form.
  const at = v.lastIndexOf("@");
  const domain = at === -1 ? v : v.slice(at + 1);
  if (/[^\x00-\x7f]/.test(domain)) {
    try {
      const ascii = new URL(`http://${domain}`).hostname;
      v = at === -1 ? ascii : `${v.slice(0, at + 1)}${ascii}`;
    } catch {
      return { error: "bad_domain" };
    }
  }
  return { value: v };
}

/**
 * @typedef {{ n: number, email: string | null, error: string | null, duplicateOf: number | null, raw?: string }} Entry
 * One entry per data row. `n` is the row number below the header, starting at 1.
 * `raw` is what was in the cell, kept for unusable rows so the page can show what was wrong.
 */

/**
 * @param {string[][]} rows
 * @param {number} column
 * @param {boolean} hasHeader
 * @returns {{ entries: Entry[], counts: { total: number, unique: number, invalid: number, duplicates: number } } | { error: string, rowCount?: number }}
 */
export function buildEntries(rows, column, hasHeader) {
  const data = hasHeader ? rows.slice(1) : rows;
  if (data.length === 0) return { error: "no_rows" };
  if (data.length > MAX_ROWS) return { error: "too_many_rows", rowCount: data.length };

  const firstSeen = new Map();
  let invalid = 0;
  let duplicates = 0;
  const entries = data.map((cells, i) => {
    const n = i + 1;
    const cleaned = normaliseCell(cells[column] ?? "");
    if ("error" in cleaned) {
      invalid++;
      return { n, email: null, error: cleaned.error, duplicateOf: null, raw: String(cells[column] ?? "").trim().slice(0, 120) };
    }
    const key = cleaned.value.toLowerCase();
    const earlier = firstSeen.get(key);
    if (earlier !== undefined) {
      duplicates++;
      return { n, email: cleaned.value, error: null, duplicateOf: earlier };
    }
    firstSeen.set(key, n);
    return { n, email: cleaned.value, error: null, duplicateOf: null };
  });
  const total = entries.length;
  return { entries, counts: { total, unique: total - invalid - duplicates, invalid, duplicates } };
}

/** The labels for the "which column?" dropdown. */
export function columnLabels(rows, hasHeader) {
  const width = Math.max(...rows.map((r) => r.length));
  return Array.from({ length: width }, (_, i) => {
    const header = hasHeader ? (rows[0][i] ?? "").trim() : "";
    return header !== "" ? header : `Column ${i + 1}`;
  });
}

/**
 * Everything the page needs to show a preview, from the raw file.
 * @param {ArrayBuffer | Uint8Array} bytes
 * @param {number} [size] file size, checked before any reading
 */
export function readUpload(bytes, size = bytes.byteLength) {
  if (size > MAX_BYTES) return { ok: false, error: "too_big" };
  const decoded = decodeBytes(bytes);
  if ("error" in decoded) return { ok: false, error: decoded.error };

  const parsed = parseCsv(decoded.text);
  if (parsed.error) return { ok: false, error: parsed.error };
  if (parsed.rows.length === 0) return { ok: false, error: "empty" };

  const choice = chooseColumn(parsed.rows);
  const column = "error" in choice ? 0 : choice.column;
  const hasHeader = "error" in choice ? true : choice.hasHeader;
  const built = buildEntries(parsed.rows, column, hasHeader);
  if ("error" in built) return { ok: false, error: built.error, rowCount: built.rowCount };

  return {
    ok: true,
    rows: parsed.rows,
    hasHeader,
    column,
    columnNeedsChoosing: "error" in choice,
    labels: columnLabels(parsed.rows, hasHeader),
    delimiter: parsed.delimiter,
    ...built,
  };
}

// ---------------------------------------------------------------------------------------------
// Writing a CSV to give back
// ---------------------------------------------------------------------------------------------

/** Quotes a cell, and defuses anything a spreadsheet would run as a formula. */
export function csvCell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * @param {string[]} header
 * @param {Array<Array<string | number | null | undefined>>} records
 */
export function toCsv(header, records) {
  const lines = [header, ...records].map((r) => r.map(csvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`; // BOM so Excel reads it as UTF-8
}
