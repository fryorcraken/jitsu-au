import { describe, it, expect } from "vitest";
import { normalizeDate, parseCsv, toBankRows } from "./bank-statement-csv";

/**
 * These tests exist because a dropped or mis-read statement line is a member
 * chased for money they already sent. So the failure paths matter more than the
 * happy one: what a file with the wrong column names does, what a preamble row
 * above the header does, what an export that puts debits in their own column
 * does. Where the answer today is wrong, the test says so and pins it anyway,
 * so the change that fixes it shows up as a change here.
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

  it("returns an empty string for anything it cannot read", () => {
    expect(normalizeDate("")).toBe("");
    expect(normalizeDate("01 Aug 2026")).toBe("");
    expect(normalizeDate("not a date")).toBe("");
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

  it("returns nothing for an empty file or a header with no rows under it", () => {
    expect(toBankRows(parseCsv(""))).toEqual([]);
    expect(toBankRows(parseCsv("Date,Description,Amount\n"))).toEqual([]);
  });

  // ---- The failure paths. Today all three are silent. ----

  it("BUG (#65): imports nothing, silently, when no column matches 'amount'", () => {
    expect(toBankRows(parseCsv("Date,Description,Money In\n01/08/2026,PAY,10\n"))).toEqual([]);
  });

  it("BUG (#65): imports rows with no date, silently, when no column matches 'date'", () => {
    expect(toBankRows(parseCsv("Posted,Description,Amount\n01/08/2026,PAY,10\n"))).toEqual([
      { posted_at: "", amount_cents: 1000, description: "PAY", reference: "" },
    ]);
  });

  it("BUG (#65): reads a preamble line as the header and imports nothing", () => {
    const withPreamble = ["Account 12345678", "Date,Description,Amount", "01/08/2026,PAY,10"].join(
      "\n",
    );
    expect(toBankRows(parseCsv(withPreamble))).toEqual([]);
  });

  it("BUG (#65): reads the debit column as the amount when it is named 'Debit Amount'", () => {
    const rows = toBankRows(
      parseCsv("Date,Description,Debit Amount,Credit Amount\n01/08/2026,EFTPOS COLES,45.50,\n"),
    );
    expect(rows).toEqual([
      { posted_at: "2026-08-01", amount_cents: 4550, description: "EFTPOS COLES", reference: "" },
    ]);
  });
});
