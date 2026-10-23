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
    expect(newPaymentReceived()).toEqual({ paidOn: clubToday(), reference: "" });
  });
});

describe("paymentReceivedProblem", () => {
  it("has nothing to say about today or an earlier day", () => {
    expect(paymentReceivedProblem({ paidOn: clubToday(), reference: "" })).toBeNull();
    expect(paymentReceivedProblem({ paidOn: "2026-01-15", reference: "" })).toBeNull();
  });

  it("asks for a day when the field is cleared", () => {
    expect(paymentReceivedProblem({ paidOn: "", reference: "" })).toMatch(/pick the day/i);
  });

  it("refuses a day that has not happened yet, as the server does", () => {
    expect(paymentReceivedProblem({ paidOn: "2999-01-01", reference: "" })).toMatch(
      /not happened yet/i,
    );
  });
});

describe("paymentReceivedParams", () => {
  it("sends a blank reference as none", () => {
    expect(paymentReceivedParams({ paidOn: "2026-01-15", reference: "   " })).toEqual({
      paid_on: "2026-01-15",
      paid_reference: undefined,
    });
  });

  // The screen and the server must agree on what the form sends.
  it("produces what the server schema accepts unchanged", () => {
    const params = paymentReceivedParams({ paidOn: "2026-01-15", reference: " Receipt 42 " });
    const parsed = markMembershipPaidSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      ...params,
    });
    expect(parsed).toMatchObject({ paid_on: "2026-01-15", paid_reference: "Receipt 42" });
  });
});
