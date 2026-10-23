import { describe, expect, it } from "vitest";
import {
  newPaymentReceived,
  paymentReceivedParams,
  paymentReceivedProblem,
} from "./payment-received";
import { clubToday, markMembershipPaidSchema } from "./validation";

describe("newPaymentReceived", () => {
  // Opening on today means taking cash at the door changes nothing.
  it("opens on today, with no reference", () => {
    expect(newPaymentReceived()).toEqual({
      paidOn: clubToday(),
      reference: "",
      openedOn: clubToday(),
    });
  });
});

describe("paymentReceivedProblem", () => {
  it("has nothing to say about today or an earlier day", () => {
    const opened = newPaymentReceived();
    expect(paymentReceivedProblem(opened)).toBeNull();
    expect(paymentReceivedProblem({ ...opened, paidOn: "2026-01-15" })).toBeNull();
  });

  it("asks for a day when the field is cleared", () => {
    expect(paymentReceivedProblem({ ...newPaymentReceived(), paidOn: "" })).toMatch(
      /pick the day/i,
    );
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
      paymentReceivedParams({ paidOn: "2026-01-15", reference: "   ", openedOn: "2026-10-23" }),
    ).toEqual({ paid_on: "2026-01-15", paid_reference: undefined });
  });

  // Untouched, the day is left to the server, which records the moment of the
  // click. Sending the opening day would book a confirm made after midnight to
  // the day before.
  it("leaves an untouched day to the server", () => {
    expect(
      paymentReceivedParams({ paidOn: "2026-10-22", reference: "", openedOn: "2026-10-22" })
        .paid_on,
    ).toBeUndefined();
  });

  // The screen and the server must agree on what the form sends.
  it("produces what the server schema accepts unchanged", () => {
    const params = paymentReceivedParams({
      paidOn: "2026-01-15",
      reference: " Receipt 42 ",
      openedOn: "2026-10-23",
    });
    const parsed = markMembershipPaidSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      ...params,
    });
    expect(parsed).toMatchObject({ paid_on: "2026-01-15", paid_reference: "Receipt 42" });
  });
});
