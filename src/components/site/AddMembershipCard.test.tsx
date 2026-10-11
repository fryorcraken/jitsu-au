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
  render(
    <AddMembershipCard
      userId="user-1"
      studentNumberOnFile={null}
      onAdded={vi.fn().mockResolvedValue(1)}
    />,
  );
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

  // Abandoning an edit is the other direction of the same guard. The panel is
  // one long-lived instance on the person's page, so without a reset a manager
  // who typed a date, thought better of it and closed would come back to a field
  // still holding it — and the next raise, for an unrelated reason, would move
  // an existing invoice's window to a date nobody meant this time.
  it("forgets a date that was typed and then abandoned", async () => {
    const user = await openWithPlan("insurance_yearly");
    const field = await screen.findByLabelText(/start date/i);
    await user.clear(field);
    await user.type(field, "2020-01-01");
    await user.click(screen.getByRole("button", { name: /^close$/i }));

    await user.click(screen.getByRole("button", { name: /add a membership/i }));
    await user.selectOptions(await screen.findByLabelText(/^plan$/i), "insurance_yearly");
    expect(await screen.findByLabelText(/start date/i)).not.toHaveValue("2020-01-01");
    await user.click(screen.getByRole("button", { name: /^add membership$/i }));
    await waitFor(() => expect(createMembership).toHaveBeenCalled());
    expect(createMembership.mock.calls[0][0].data.starts_on).toBeNull();
  });

  // A date chosen for one plan is not an answer about another.
  it("forgets a date after switching plans and back", async () => {
    const user = await openWithPlan("insurance_yearly");
    const field = await screen.findByLabelText(/start date/i);
    await user.clear(field);
    await user.type(field, "2020-01-01");
    const plan = screen.getByLabelText(/^plan$/i);
    await user.selectOptions(plan, "2026-s2");
    await user.selectOptions(plan, "insurance_yearly");
    expect(await screen.findByLabelText(/start date/i)).not.toHaveValue("2020-01-01");
    await user.click(screen.getByRole("button", { name: /^add membership$/i }));
    await waitFor(() => expect(createMembership).toHaveBeenCalled());
    expect(createMembership.mock.calls[0][0].data.starts_on).toBeNull();
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

// The rate used to be a side effect of a free-text box: a number there made the
// invoice come out at the student rate while every price on screen still said
// the public one, and a box that started empty invoiced a UTS student the public
// rate. These pin the rate as a visible choice, priced on each side, defaulting
// to the person's record, and that what is ticked is what the server is sent.
describe("AddMembershipCard rate", () => {
  const SEMESTER = { ...PERIOD, public_price_cents: 44500, student_price_cents: 24500 };

  beforeEach(() => {
    createMembership.mockClear();
    listAllMembershipPlans.mockReset();
    listAllMembershipPlans.mockResolvedValue([SEMESTER, YEARLY]);
    createMembership.mockResolvedValue({ ok: true, reference: "LEE1234" });
  });

  async function openOn(onFile: string | null, code = "2026-s2") {
    const user = userEvent.setup();
    render(
      <AddMembershipCard
        userId="user-1"
        studentNumberOnFile={onFile}
        onAdded={vi.fn().mockResolvedValue(1)}
      />,
    );
    await user.click(screen.getByRole("button", { name: /add a membership/i }));
    await user.selectOptions(await screen.findByLabelText(/^plan$/i), code);
    return user;
  }

  async function sent(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /^add membership$/i }));
    await waitFor(() => expect(createMembership).toHaveBeenCalled());
    return createMembership.mock.calls[0][0].data.uts_student_number;
  }

  it("lists both prices before anything is chosen", async () => {
    await openOn(null);
    expect(
      screen.getByRole("option", { name: "Semester 2 2026 ($445, students $245)" }),
    ).toBeInTheDocument();
  });

  it("picks the student rate, with their number, when their record has one", async () => {
    const user = await openOn("12345678");
    expect(screen.getByRole("radio", { name: /student rate, \$245/i })).toBeChecked();
    expect(screen.getByLabelText(/uts student number/i)).toHaveValue("12345678");
    expect(await sent(user)).toBe("12345678");
  });

  it("picks the public rate and sends no number when their record has none", async () => {
    const user = await openOn(null);
    expect(screen.getByRole("radio", { name: /public rate, \$445/i })).toBeChecked();
    expect(screen.queryByLabelText(/uts student number/i)).not.toBeInTheDocument();
    expect(await sent(user)).toBeNull();
  });

  // The number on file must not ride along once the manager has said public,
  // or the server would charge the student rate behind the ticked radio.
  it("sends no number when the manager switches a student to the public rate", async () => {
    const user = await openOn("12345678");
    await user.click(screen.getByRole("radio", { name: /public rate/i }));
    expect(await sent(user)).toBeNull();
  });

  it("will not raise at the student rate without a number", async () => {
    const user = await openOn(null);
    await user.click(screen.getByRole("radio", { name: /student rate/i }));
    expect(screen.getByRole("button", { name: /^add membership$/i })).toBeDisabled();
    await user.type(screen.getByLabelText(/uts student number/i), "999");
    expect(screen.getByText(/for this invoice only/i)).toBeInTheDocument();
    expect(await sent(user)).toBe("999");
  });

  it("asks nothing about rates on a plan with one price", async () => {
    await openOn(null, "insurance_yearly");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  // An edit is for one invoice. Reopening starts from the record again.
  it("goes back to the record each time the panel opens", async () => {
    const user = await openOn("12345678");
    await user.click(screen.getByRole("radio", { name: /public rate/i }));
    await user.click(screen.getByRole("button", { name: /^close$/i }));
    await user.click(screen.getByRole("button", { name: /add a membership/i }));
    await user.selectOptions(await screen.findByLabelText(/^plan$/i), "2026-s2");
    expect(screen.getByRole("radio", { name: /student rate/i })).toBeChecked();
  });
});
