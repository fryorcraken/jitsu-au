import { describe, it, expect } from "vitest";
import { detectStatementColumns, normalizeDate, parseCsv, toBankRows } from "./bank-statement-csv";

/**
 * These tests exist because a dropped or mis-read statement line is a member
 * chased for money they already sent. So the failure paths matter more than the
 * happy one: what a file with the wrong column names does, what a preamble row
 * above the header does, what an export that puts debits in their own column
 * does. The four cases at the bottom used to pass silently and now refuse the
 * file by name, which is the whole point of the exercise.
 */

describe("parseCsv", () => {
  it("reads plain rows", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps commas inside a quoted field", () => {
    expect(parseCsv('date,description\n2026-08-01,"OSKO PAYMENT, UTS-0042"\n')).toEqual([
      ["date", "description"],
      ["2026-08-01", "OSKO PAYMENT, UTS-0042"],
    ]);
  });

  it('unescapes a doubled "" inside a quoted field', () => {
    expect(parseCsv('a\n"she said ""hi"" twice"\n')).toEqual([["a"], ['she said "hi" twice']]);
  });

  it("keeps a newline inside a quoted field", () => {
    expect(parseCsv('a,b\n"line one\nline two",x\n')).toEqual([
      ["a", "b"],
      ["line one\nline two", "x"],
    ]);
  });

  it("handles CRLF and lone CR line endings", () => {
    const expected = [
      ["a", "b"],
      ["1", "2"],
    ];
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual(expected);
    expect(parseCsv("a,b\r1,2\r")).toEqual(expected);
  });

  it("reads the last row when the file has no trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("drops blank and whitespace-only lines", () => {
    expect(parseCsv("a,b\n\n1,2\n   ,  \n3,4\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("returns nothing for an empty file", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n\n")).toEqual([]);
  });

  it("keeps a UTF-8 BOM on the first field (the header match trims it)", () => {
    expect(parseCsv("﻿Date,Amount\n2026-08-01,10\n")[0]).toEqual(["﻿Date", "Amount"]);
  });

  it("keeps empty fields, including a quoted empty one", () => {
    expect(parseCsv('a,b,c\n1,,""\n')).toEqual([
      ["a", "b", "c"],
      ["1", "", ""],
    ]);
  });
});

describe("normalizeDate", () => {
  it("passes an ISO date through, with or without a time", () => {
    expect(normalizeDate("2026-08-01")).toBe("2026-08-01");
    expect(normalizeDate(" 2026-08-01T09:30:00+10:00 ")).toBe("2026-08-01");
  });

  it("reads AU day-first dates with any separator", () => {
    expect(normalizeDate("01/08/2026")).toBe("2026-08-01");
    expect(normalizeDate("1-8-2026")).toBe("2026-08-01");
    expect(normalizeDate("1.8.26")).toBe("2026-08-01");
  });

  it("reads an ambiguous date day-first, as an Australian bank writes it", () => {
    expect(normalizeDate("03/04/2026")).toBe("2026-04-03");
  });

  it("ignores a time printed after the date", () => {
    expect(normalizeDate("01/08/2026 09:15 AM")).toBe("2026-08-01");
    expect(normalizeDate("01/08/2026T09:15")).toBe("2026-08-01");
  });

  it("returns an empty string for anything it cannot read", () => {
    expect(normalizeDate("")).toBe("");
    expect(normalizeDate("01 Aug 2026")).toBe("");
    expect(normalizeDate("not a date")).toBe("");
  });

  it("returns an empty string rather than an impossible date", () => {
    // A US-formatted export: day 8 of month 13. Passing "2026-13-08" on would
    // clear the row schema's regex and kill the whole import at insert time.
    expect(normalizeDate("08/13/2026")).toBe("");
    expect(normalizeDate("99/99/9999")).toBe("");
    expect(normalizeDate("30/02/2026")).toBe("");
    expect(normalizeDate("2026-02-30")).toBe("");
    expect(normalizeDate("29/02/2028")).toBe("2028-02-29"); // a real leap day
  });
});

/** A statement the way a bank actually exports one, header row included. */
const STATEMENT = [
  "Date,Description,Amount,Balance",
  '01/08/2026,"OSKO PAYMENT UTS-0042 SMITH",120.00,1000.00',
  '02/08/2026,"EFTPOS COLES",-45.50,954.50',
  '03/08/2026,"TRANSFER UTS-0043","1,234.50",2189.00',
].join("\n");

describe("toBankRows", () => {
  it("keeps incoming credits only, with the date normalized", () => {
    expect(toBankRows(parseCsv(STATEMENT))).toEqual([
      {
        posted_at: "2026-08-01",
        amount_cents: 12000,
        description: "OSKO PAYMENT UTS-0042 SMITH",
        reference: "",
      },
      {
        posted_at: "2026-08-03",
        amount_cents: 123450,
        description: "TRANSFER UTS-0043",
        reference: "",
      },
    ]);
  });

  it("skips a zero-amount row", () => {
    expect(toBankRows(parseCsv("Date,Description,Amount\n01/08/2026,NIL,0.00\n"))).toEqual([]);
  });

  it("matches header names whatever their case, spacing or BOM", () => {
    const rows = toBankRows(parseCsv("﻿ Transaction Date , Narrative , Credit Amount \nX,Y,5\n"));
    expect(rows).toEqual([{ posted_at: "", amount_cents: 500, description: "Y", reference: "" }]);
  });

  it("fills a missing trailing cell rather than throwing", () => {
    expect(toBankRows(parseCsv("Date,Description,Amount,Reference\n01/08/2026,PAY,10"))).toEqual([
      { posted_at: "2026-08-01", amount_cents: 1000, description: "PAY", reference: "" },
    ]);
  });

  it("uses the reference column for the description when there is no description column", () => {
    expect(toBankRows(parseCsv("Date,Reference,Amount\n01/08/2026,UTS-0042,10"))).toEqual([
      {
        posted_at: "2026-08-01",
        amount_cents: 1000,
        description: "UTS-0042",
        reference: "UTS-0042",
      },
    ]);
  });

  it("returns nothing for a header row with no transactions under it", () => {
    expect(toBankRows(parseCsv("Date,Description,Amount\n"))).toEqual([]);
  });

  it("refuses an empty file rather than calling it a statement with no credits", () => {
    expect(() => toBankRows(parseCsv(""))).toThrow(/empty/i);
  });

  // ---- The failure paths (#65). Each one used to be silent. ----

  it("names the Amount column when no header matches it", () => {
    expect(() => toBankRows(parseCsv("Date,Description,Money In\n01/08/2026,PAY,10\n"))).toThrow(
      /could not find an Amount column/,
    );
  });

  it("names the Date column when no header matches it", () => {
    expect(() => toBankRows(parseCsv("Posted,Description,Amount\n01/08/2026,PAY,10\n"))).toThrow(
      /could not find a Date column/,
    );
  });

  it("names the Description column when no header matches it", () => {
    expect(() => toBankRows(parseCsv("Date,Amount\n01/08/2026,10\n"))).toThrow(
      /could not find a Description column/,
    );
  });

  it("lists every missing column, and says to delete a preamble above the headings", () => {
    const withPreamble = ["Account 12345678", "Date,Description,Amount", "01/08/2026,PAY,10"].join(
      "\n",
    );
    expect(() => toBankRows(parseCsv(withPreamble))).toThrow(
      /the Date, Amount and Description columns.*delete anything printed above them/s,
    );
  });

  it("reads the credit column, not the debit one, when the export has both", () => {
    const statement = [
      "Date,Description,Debit Amount,Credit Amount",
      "01/08/2026,EFTPOS COLES,45.50,",
      "02/08/2026,OSKO UTS-0042,,120.00",
    ].join("\n");
    expect(toBankRows(parseCsv(statement))).toEqual([
      {
        posted_at: "2026-08-02",
        amount_cents: 12000,
        description: "OSKO UTS-0042",
        reference: "",
      },
    ]);
  });
});

describe("detectStatementColumns", () => {
  it("finds each column by substring, whatever the header is called around it", () => {
    expect(
      detectStatementColumns(["Transaction Date", "Narrative", "Amount", "Reference", "Balance"]),
    ).toEqual({ dateIdx: 0, amountIdx: 2, descIdx: 1, refIdx: 3 });
  });

  it("reports -1 for a column the header row does not have", () => {
    expect(detectStatementColumns(["Date", "Description", "Amount"]).refIdx).toBe(-1);
    expect(detectStatementColumns([]).dateIdx).toBe(-1);
  });

  it("prefers a credit or deposit column over a plain amount one", () => {
    expect(detectStatementColumns(["Date", "Amount", "Credit"]).amountIdx).toBe(2);
    expect(detectStatementColumns(["Date", "Amount", "Deposits"]).amountIdx).toBe(2);
  });

  it("never picks a debit or withdrawal column as the amount", () => {
    expect(detectStatementColumns(["Date", "Debit Amount"]).amountIdx).toBe(-1);
    expect(detectStatementColumns(["Date", "Withdrawal Amount"]).amountIdx).toBe(-1);
    expect(detectStatementColumns(["Date", "Debit Amount", "Credit Amount"]).amountIdx).toBe(2);
  });

  it("never picks a column that is not money moving: an indicator, a limit, a balance", () => {
    // "Debit/Credit" holds DR/CR, "Credit Limit" is a ceiling, neither is a sum.
    const indicator = ["Date", "Description", "Amount", "Debit/Credit"];
    expect(detectStatementColumns(indicator).amountIdx).toBe(2);
    expect(
      detectStatementColumns(["Date", "Description", "Credit Limit", "Amount"]).amountIdx,
    ).toBe(3);
    expect(detectStatementColumns(["Date", "Closing Balance", "Amount"]).amountIdx).toBe(2);
  });

  it("prefers a narrative over a reference for the description, whatever their order", () => {
    expect(detectStatementColumns(["Date", "Reference", "Narrative", "Amount"])).toEqual({
      dateIdx: 0,
      amountIdx: 3,
      descIdx: 2,
      refIdx: 1,
    });
  });
});
