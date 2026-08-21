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

/** Normalize a date cell to YYYY-MM-DD (accepts ISO or AU dd/mm/yyyy). */
export function normalizeDate(value: string): string {
  const t = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(t);
  if (m) {
    const [, d, mo, y] = m;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return "";
}

/** Map parsed CSV into the bank-row shape, keeping only positive credits. */
export function toBankRows(rows: string[][]): BankTxnRow[] {
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const find = (...keys: string[]) => header.findIndex((h) => keys.some((k) => h.includes(k)));
  const dateIdx = find("date");
  const amountIdx = find("amount", "credit", "deposit");
  const descIdx = find("description", "narrative", "details", "reference", "memo");
  const refIdx = find("reference");

  const out: BankTxnRow[] = [];
  for (const r of rows.slice(1)) {
    const cents = amountIdx >= 0 ? parseMoneyToCents(r[amountIdx] ?? "") : null;
    if (cents == null || cents <= 0) continue; // only incoming credits can pay a membership
    out.push({
      posted_at: dateIdx >= 0 ? normalizeDate(r[dateIdx] ?? "") : "",
      amount_cents: cents,
      description: descIdx >= 0 ? (r[descIdx] ?? "").trim() : "",
      reference: refIdx >= 0 ? (r[refIdx] ?? "").trim() : "",
    });
  }
  return out;
}
