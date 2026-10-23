import { describe, expect, it } from "vitest";
import {
  newPaymentReceived,
  paymentReceivedParams,
  paymentReceivedProblem,
} from "./payment-received";
import { clubToday, markMembershipPaidSchema } from "./validation";

/** A day a month ago: in the past, and well inside the two-year limit, whenever this runs. */
const RECENT_DAY = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

describe("newPaymentReceived", () => {
  // Opening on today means taking cash at the door changes nothing.
  it("opens on today, with no reference", () => {
    expect(newPaymentReceived()).toEqual({
      paidOn: clubToday(),
      reference: "",
      dateChosen: false,
    });
  });
});

describe("paymentReceivedProblem", () => {
  it("has nothing to say about today or an earlier day", () => {
    const opened = newPaymentReceived();
    expect(paymentReceivedProblem(opened)).toBeNull();
    expect(paymentReceivedProblem({ ...opened, paidOn: RECENT_DAY })).toBeNull();
  });

  // In the picker's own terms: it shows dd/mm/yyyy, so "as YYYY-MM-DD" (the
  // server's wording for an agent) would ask for a format nobody can type there.
  it("asks for a day when the field is cleared, without naming a format", () => {
    const problem = paymentReceivedProblem({ ...newPaymentReceived(), paidOn: "" });
    expect(problem).toMatch(/pick the day/i);
    expect(problem).not.toMatch(/YYYY/);
  });

  it("refuses a day that has not happened yet, as the server does", () => {
    expect(paymentReceivedProblem({ ...newPaymentReceived(), paidOn: "2999-01-01" })).toMatch(
      /not happened yet/i,
    );
  });

  // The same rule as the server, so an impossible day is caught before the click.
  it("refuses a day that is not on the calendar", () => {
    expect(paymentReceivedProblem({ ...newPaymentReceived(), paidOn: "2026-02-31" })).toMatch(
      /not a real date/i,
    );
  });
});

describe("paymentReceivedParams", () => {
  it("sends a blank reference as none", () => {
    expect(
      paymentReceivedParams({ paidOn: RECENT_DAY, reference: "   ", dateChosen: true }),
    ).toEqual({ paid_on: RECENT_DAY, paid_reference: undefined });
  });

  // Untouched, the day is left to the server, which records the moment of the
  // click. Sending the opening day would book a confirm made after midnight to
  // the day before.
  it("leaves an untouched day to the server", () => {
    expect(
      paymentReceivedParams({ paidOn: "2026-10-22", reference: "", dateChosen: false }).paid_on,
    ).toBeUndefined();
  });

  // Picking the opening day again is still a choice, and it is the day stored.
  it("sends a day the manager picked, even when it is the one it opened on", () => {
    expect(
      paymentReceivedParams({ paidOn: "2026-10-22", reference: "", dateChosen: true }).paid_on,
    ).toBe("2026-10-22");
  });

  // The screen and the server must agree on what the form sends.
  it("produces what the server schema accepts unchanged", () => {
    const params = paymentReceivedParams({
      paidOn: RECENT_DAY,
      reference: " Receipt 42 ",
      dateChosen: true,
    });
    const parsed = markMembershipPaidSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      ...params,
    });
    expect(parsed).toMatchObject({ paid_on: RECENT_DAY, paid_reference: "Receipt 42" });
  });
});
