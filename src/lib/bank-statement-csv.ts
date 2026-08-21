// Reading a bank statement export.
//
// This is the path money recognition runs through. Payments are manual bank
// transfers, so a statement CSV is how the club learns who has paid: a row that
// is dropped here is a member who gets chased for money they already sent.
//
// It lives in `src/lib/` rather than in `/manager/reconciliation` for one
// reason: real exports vary far more than they look (quoted fields, `\r\n`,
// a BOM, `DD/MM/YYYY` versus ISO dates, thousands separators, debits in their
// own column), and the only way to be sure about any of that is to import the
// functions and test them directly. Keep it free of React, server and Supabase
// imports so it stays that way, mirroring `validation.ts`.

import { parseMoneyToCents, type BankTxnRow } from "@/lib/validation";

/** Minimal RFC-4180-ish CSV parser (handles quoted fields and commas). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((v) => v.trim() !== "")) rows.push(row);
  }
  return rows;
}

/** True for a real calendar date, so an impossible one never leaves this file. */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Normalize a date cell to YYYY-MM-DD (accepts ISO or AU dd/mm/yyyy), or "" for
 * anything it cannot read as a real date.
 *
 * The range check is not fussiness. A US-formatted export reads `08/13/2026` as
 * day 8 of month 13, and `2026-13-08` clears `bankTxnRowSchema`'s regex happily,
 * so the whole import then dies at insert time on a raw Postgres range error
 * with nothing on screen worth reading. An unreadable date costs the row its
 * date; it must not cost the manager the import.
 */
export function normalizeDate(value: string): string {
  const t = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) {
    const [, y, mo, d] = iso;
    return isRealDate(Number(y), Number(mo), Number(d)) ? t.slice(0, 10) : "";
  }
  // A day-first date, optionally followed by a time we have no use for.
  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:[ T].*)?$/.exec(t);
  if (m) {
    const [, d, mo, y] = m;
    const year = y.length === 2 ? `20${y}` : y;
    if (!isRealDate(Number(year), Number(mo), Number(d))) return "";
    return `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return "";
}

/**
 * Which cell of a statement row holds what. `-1` means the header row named no
 * column we could recognise as that one.
 */
export type StatementColumns = {
  dateIdx: number;
  amountIdx: number;
  descIdx: number;
  refIdx: number;
  /** A DR/CR column saying which way each row went, when the file has one. */
  debitFlagIdx: number;
};

/** The three the import promises to read, in the words the screen uses. */
const REQUIRED_COLUMNS = [
  ["Date", "dateIdx"],
  ["Amount", "amountIdx"],
  ["Description", "descIdx"],
] as const;

/**
 * Headers in the order we would rather read the description from. Reference is
 * last on purpose: it is better than nothing, but a bank that gives us both
 * wrote the narrative for a human to read and the reference for a machine.
 */
const DESCRIPTION_KEYS = ["description", "narrative", "details", "memo", "reference"];

/** Never the amount, whatever else the header says. */
const NOT_AN_AMOUNT = ["debit", "withdrawal", "limit", "balance"];

/**
 * What may sit beside "credit" or "deposit" in a header and still leave it a
 * money-in column. Anything else in there means the header is about something
 * other than the money: "Credit Card Surcharge" is a fee, not a payment to us.
 */
const CREDIT_HEADER_WORDS = new Set([
  "credit",
  "credits",
  "deposit",
  "deposits",
  "amount",
  "amounts",
  "money",
  "in",
  "total",
  "aud",
  "$",
]);

const CREDIT_WORDS = ["credit", "credits", "deposit", "deposits"];

function isCreditColumn(header: string): boolean {
  const words = header.split(/[^a-z$]+/).filter(Boolean);
  if (!words.some((w) => CREDIT_WORDS.includes(w))) return false;
  return words.every((w) => CREDIT_HEADER_WORDS.has(w));
}

/** A column saying which way the row went rather than how much: DR/CR. */
function isDebitCreditFlag(header: string): boolean {
  if (header.includes("debit") && header.includes("credit")) return true;
  return /\b(dr|cr)\s*[/|-]\s*(dr|cr)\b/.test(header);
}

/** How such a column spells "this one went out". Anything else leaves the row alone. */
const DEBIT_MARKERS = new Set(["d", "dr", "db", "debit", "w", "withdrawal", "-"]);

/** True when this row's DR/CR cell says the money went out. */
export function isDebitRow(flagCell: string): boolean {
  return DEBIT_MARKERS.has(flagCell.trim().toLowerCase());
}

/**
 * Work out which column is which from the header row, by substring.
 *
 * The amount column is the one worth reading twice, because getting it wrong
 * means a card purchase imports as a payment to the club. Three shapes of
 * export have to land right:
 *
 *   Amount (signed)                 -> the plain case, negatives dropped later
 *   Debit Amount | Credit Amount    -> a first-match on "amount" picks the
 *                                      DEBIT one, so nothing naming a debit, a
 *                                      withdrawal, a limit or a balance is
 *                                      ever the amount
 *   Amount (unsigned) | Debit/Credit-> the sign lives in a separate DR/CR
 *                                      column, so we find that column here and
 *                                      `toBankRows` skips the rows it marks out
 *
 * Among what is left a header naming a credit or a deposit wins over a plain
 * "amount", but only when the rest of the header agrees it is a money column:
 * "Credit Card Surcharge" contains "credit" and is not one.
 */
export function detectStatementColumns(headerRow: string[]): StatementColumns {
  const header = headerRow.map((h) => h.trim().toLowerCase());
  const find = (...keys: string[]) => header.findIndex((h) => keys.some((k) => h.includes(k)));
  const couldBeAmount = (h: string) => !NOT_AN_AMOUNT.some((k) => h.includes(k));

  const creditIdx = header.findIndex((h) => couldBeAmount(h) && isCreditColumn(h));
  const amountIdx =
    creditIdx >= 0 ? creditIdx : header.findIndex((h) => h.includes("amount") && couldBeAmount(h));

  // By key, not by column order: whichever of these the file has, the earliest
  // key that appears anywhere in the header wins.
  const descIdx = DESCRIPTION_KEYS.map((k) => find(k)).find((i) => i >= 0) ?? -1;

  return {
    dateIdx: find("date"),
    amountIdx,
    descIdx,
    refIdx: find("reference"),
    debitFlagIdx: header.findIndex(isDebitCreditFlag),
  };
}

/** "a Date column" / "the Date and Amount columns" — for the error below. */
function columnList(missing: string[]): string {
  if (missing.length === 1)
    return `${/^[AEIOU]/.test(missing[0]) ? "an" : "a"} ${missing[0]} column`;
  const last = missing[missing.length - 1];
  return `the ${missing.slice(0, -1).join(", ")} and ${last} columns`;
}

/**
 * Map parsed CSV into the bank-row shape, keeping only positive credits.
 *
 * Throws when a column it needs is not in the header row. Returning nothing
 * would be the quieter option and it is the wrong one: an export with columns
 * named differently, or with the bank's account summary printed above the
 * headings, then imports zero rows and reads as "nothing came in this month".
 * Someone finds out weeks later, when a member who paid gets chased for it.
 */
export function toBankRows(rows: string[][]): BankTxnRow[] {
  if (rows.length === 0) {
    throw new Error("That file is empty. Export the statement from your bank again and try that.");
  }
  const columns = detectStatementColumns(rows[0]);
  const missing = REQUIRED_COLUMNS.filter(([, key]) => columns[key] < 0).map(([label]) => label);
  if (missing.length > 0) {
    throw new Error(
      `We could not find ${columnList(missing)} in that file. The first row has to be the column ` +
        `headings from your bank, so delete anything printed above them and try again.`,
    );
  }

  const out: BankTxnRow[] = [];
  for (const r of rows.slice(1)) {
    // An unsigned amount beside a DR/CR column: the sign is over there.
    if (columns.debitFlagIdx >= 0 && isDebitRow(r[columns.debitFlagIdx] ?? "")) continue;
    const cents = parseMoneyToCents(r[columns.amountIdx] ?? "");
    if (cents == null || cents <= 0) continue; // only incoming credits can pay a membership
    out.push({
      posted_at: normalizeDate(r[columns.dateIdx] ?? ""),
      amount_cents: cents,
      description: (r[columns.descIdx] ?? "").trim(),
      reference: columns.refIdx >= 0 ? (r[columns.refIdx] ?? "").trim() : "",
    });
  }
  return out;
}
