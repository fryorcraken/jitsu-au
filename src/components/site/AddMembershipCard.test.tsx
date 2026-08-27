// Raising a membership for somebody, and the one field on this panel that can
// change a record that already exists.
//
// The Start date is prefilled with today, which is right almost every time and
// is also what makes it dangerous: re-raising a plan resolves back to the
// person's existing unpaid invoice and MOVES its window to the date sent. A
// panel that always sent its prefill would drag a deliberately backdated year of
// cover forward to today the next time a manager opened it to fix a student
// number. So an untouched field means "no opinion", and these pin that.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createMembership = vi.fn();
const listAllMembershipPlans = vi.fn();

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/membership.functions", () => ({
  createMembership: (...args: unknown[]) => createMembership(...args),
  listAllMembershipPlans: (...args: unknown[]) => listAllMembershipPlans(...args),
}));

const { AddMembershipCard } = await import("./AddMembershipCard");

/** The yearly insurance: a fixed length, and where it sits is a real choice. */
const YEARLY = {
  id: "plan-insurance",
  code: "insurance_yearly",
  name: "Yearly insurance",
  kind: "insurance",
  public_price_cents: 5000,
  student_price_cents: null,
  is_active: true,
  starts_on: null,
  ends_on: null,
  duration_days: 365,
  session_credits: null,
  sort_order: 1,
};

/** A training period: its dates belong to the plan, so there is nothing to set. */
const PERIOD = {
  ...YEARLY,
  id: "plan-period",
  code: "2026-s2",
  name: "Semester 2 2026",
  kind: "period",
  starts_on: "2026-07-20",
  ends_on: "2026-11-22",
  duration_days: null,
  sort_order: 0,
};

async function openWithPlan(code: string) {
  const user = userEvent.setup();
  listAllMembershipPlans.mockResolvedValue([PERIOD, YEARLY]);
  createMembership.mockResolvedValue({ ok: true, reference: "LEE1234" });
  render(<AddMembershipCard userId="user-1" onAdded={vi.fn().mockResolvedValue(1)} />);
  await user.click(screen.getByRole("button", { name: /add a membership/i }));
  const plan = await screen.findByLabelText(/^plan$/i);
  await user.selectOptions(plan, code);
  return user;
}

describe("AddMembershipCard start date", () => {
  // Cleared per test: every case below reads the FIRST call, and a mock carried
  // over from the previous test would answer with that test's payload.
  beforeEach(() => {
    createMembership.mockClear();
    listAllMembershipPlans.mockClear();
  });

  it("asks for a start date on the yearly cover", async () => {
    await openWithPlan("insurance_yearly");
    expect(await screen.findByLabelText(/start date/i)).toBeInTheDocument();
  });

  it("does not ask on a plan whose dates belong to the plan", async () => {
    await openWithPlan("2026-s2");
    expect(screen.queryByLabelText(/start date/i)).not.toBeInTheDocument();
  });

  // The prefill is a suggestion, not an answer. Sending it would move an
  // existing unpaid invoice's window with nothing on screen to say so.
  it("sends no start date while the manager has not set one", async () => {
    const user = await openWithPlan("insurance_yearly");
    await screen.findByLabelText(/start date/i);
    await user.click(screen.getByRole("button", { name: /^add membership$/i }));
    await waitFor(() => expect(createMembership).toHaveBeenCalled());
    expect(createMembership.mock.calls[0][0].data.starts_on).toBeNull();
  });

  it("sends the day the manager actually picked", async () => {
    const user = await openWithPlan("insurance_yearly");
    const field = await screen.findByLabelText(/start date/i);
    await user.clear(field);
    await user.type(field, "2026-02-01");
    await user.click(screen.getByRole("button", { name: /^add membership$/i }));
    await waitFor(() => expect(createMembership).toHaveBeenCalled());
    expect(createMembership.mock.calls[0][0].data.starts_on).toBe("2026-02-01");
  });

  // Nothing to place on a casual class or a training period, and the server
  // refuses a date there — so a stale value must never ride along.
  it("sends no start date for a plan that has none, even after picking one", async () => {
    const user = await openWithPlan("insurance_yearly");
    const field = await screen.findByLabelText(/start date/i);
    await user.clear(field);
    await user.type(field, "2026-02-01");
    await user.selectOptions(screen.getByLabelText(/^plan$/i), "2026-s2");
    await user.click(screen.getByRole("button", { name: /^add membership$/i }));
    await waitFor(() => expect(createMembership).toHaveBeenCalled());
    expect(createMembership.mock.calls[0][0].data.starts_on).toBeNull();
  });
});
