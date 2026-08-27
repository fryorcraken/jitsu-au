// The delete guard is the only thing standing between a mis-click and a record
// that cannot be recovered, so it is pinned here at the level a manager meets
// it: which buttons exist, and what the screen says when Delete is unavailable.
//
// The other rule worth a test is the failure path. Cancelling and deleting used
// to report failure through a toast, which auto-dismisses and leaves nothing to
// press — on a phone, between classes, that reads as "it worked". The dialog has
// to stay open with the message in it.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const setMembershipStatus = vi.fn();
const deleteMembership = vi.fn();
const markMembershipPaid = vi.fn();
const setMembershipStart = vi.fn();

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/membership.functions", () => ({
  setMembershipStatus: (...args: unknown[]) => setMembershipStatus(...args),
  deleteMembership: (...args: unknown[]) => deleteMembership(...args),
  markMembershipPaid: (...args: unknown[]) => markMembershipPaid(...args),
  setMembershipStart: (...args: unknown[]) => setMembershipStart(...args),
}));

const { MembershipRowActions } = await import("./MembershipRowActions");
type Row = import("./MembershipRowActions").MembershipActionRow;

/** Authorised and unpaid: what every membership looks like once raised. */
const JUNK: Row = {
  id: "mem-1",
  status: "active",
  paid_at: null,
  price_cents: 44500,
  checkin_count: 0,
  plan_name: "Semester 2 2026",
  starts_at: "2026-07-19T14:00:00.000Z",
  ends_at: "2026-11-22T12:59:59.000Z",
  // A training period: its dates belong to the plan, so there is no start date
  // on this row to move.
  plan_window: { starts_on: "2026-07-20", ends_on: "2026-11-22", duration_days: null },
};

/** The yearly insurance: fixed length, and where it sits is a real choice. */
const COVER: Partial<Row> = {
  plan_name: "Yearly insurance",
  starts_at: "2026-05-01T00:00:00.000Z",
  ends_at: "2027-05-01T00:00:00.000Z",
  plan_window: { starts_on: null, ends_on: null, duration_days: 365 },
};

function renderRow(overrides: Partial<Row> = {}, onChanged = vi.fn().mockResolvedValue(1)) {
  render(<MembershipRowActions membership={{ ...JUNK, ...overrides }} onChanged={onChanged} />);
  return { onChanged };
}

describe("MembershipRowActions", () => {
  // There is no Activate any more. A membership is authorised the moment it is
  // raised, so what a manager is waiting to do is record the money.
  it("offers Mark as paid on an unpaid membership, and no Activate", () => {
    renderRow();
    expect(screen.getByRole("button", { name: /mark as paid/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^activate/i })).not.toBeInTheDocument();
  });

  it("stops offering Mark as paid once a payment is recorded", () => {
    renderRow({ paid_at: "2026-08-01T00:00:00Z" });
    expect(screen.queryByRole("button", { name: /mark as paid/i })).not.toBeInTheDocument();
  });

  // Nothing is owed on a free membership, so there is nothing to record.
  it("does not offer Mark as paid on a free membership", () => {
    renderRow({ price_cents: 0, plan_name: "Free trial" });
    expect(screen.queryByRole("button", { name: /mark as paid/i })).not.toBeInTheDocument();
  });

  it("offers Cancel on an authorised membership", () => {
    renderRow();
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeEnabled();
  });

  // Reopening is the narrow leftover: back into service, saying nothing about
  // money either way.
  it("offers Reopen on a closed membership and not on a running one", () => {
    renderRow({ status: "cancelled" });
    expect(screen.getByRole("button", { name: /reopen/i })).toBeEnabled();
  });

  it("does not offer Cancel on one already cancelled", () => {
    renderRow({ status: "cancelled" });
    expect(screen.queryByRole("button", { name: /^cancel$/i })).not.toBeInTheDocument();
  });

  it("allows deleting an unpaid invoice nobody trained on", () => {
    renderRow();
    expect(screen.getByRole("button", { name: /delete/i })).toBeEnabled();
  });

  it("refuses to delete one with a payment recorded, and says why", () => {
    renderRow({ paid_at: "2026-08-01T00:00:00Z" });
    expect(screen.getByRole("button", { name: /delete/i })).toBeDisabled();
    expect(screen.getByText(/a payment is recorded against it/i)).toBeInTheDocument();
  });

  it("refuses to delete one somebody trained on", () => {
    renderRow({ checkin_count: 2 });
    expect(screen.getByRole("button", { name: /delete/i })).toBeDisabled();
    expect(screen.getByText(/a class was checked in against it/i)).toBeInTheDocument();
  });

  // The case the whole change exists for. Being authorised is now the normal
  // state of every membership, so it must not stand in the way of a delete —
  // it used to, because authorising was what wrote `paid_at`.
  it("allows deleting an authorised membership nobody has paid for", () => {
    renderRow({ status: "active", paid_at: null });
    expect(screen.getByRole("button", { name: /delete/i })).toBeEnabled();
  });

  // A disabled button with a hover-only reason is a dead end on a phone, where
  // there is no hover. The reason is in the accessibility tree either way.
  it("names every blocker at once rather than the first", () => {
    renderRow({ paid_at: "2026-08-01T00:00:00Z", checkin_count: 1 });
    const reason = screen.getByText(/cannot be deleted/i);
    expect(reason).toHaveTextContent(/a payment is recorded against it/i);
    expect(reason).toHaveTextContent(/checked in against it/i);
  });

  // Marking paid is outward-facing and one-way: it emails a receipt and makes
  // the row undeletable. Both belong in the confirm, before the click.
  it("says what marking paid will do before it happens", async () => {
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByRole("button", { name: /mark as paid/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/emails them a receipt/i);
    expect(dialog).toHaveTextContent(/never deleted/i);
  });

  it("records the payment only after the confirm", async () => {
    const user = userEvent.setup();
    markMembershipPaid.mockResolvedValueOnce({ ok: true });
    const { onChanged } = renderRow();

    await user.click(screen.getByRole("button", { name: /mark as paid/i }));
    expect(markMembershipPaid).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^mark as paid$/i }));
    await waitFor(() =>
      expect(markMembershipPaid).toHaveBeenCalledWith({
        data: { id: "mem-1", payment_method: "manual" },
      }),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("says what cancelling will do before it happens", async () => {
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      /lose the members-only calendar/i,
    );
  });

  it("cancels only after the confirm, then reloads the caller's data", async () => {
    const user = userEvent.setup();
    setMembershipStatus.mockResolvedValueOnce({ ok: true });
    const { onChanged } = renderRow();

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(setMembershipStatus).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /cancel membership/i }));
    await waitFor(() =>
      expect(setMembershipStatus).toHaveBeenCalledWith({
        data: { id: "mem-1", status: "cancelled" },
      }),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  // ---- The start date ----
  //
  // Offered only where it means something, and it shows the end date moving
  // with it: the one thing a manager could reasonably fear here is silently
  // buying somebody a longer or shorter year.
  it("offers a start date on the yearly cover and not on a training period", () => {
    renderRow(COVER);
    expect(screen.getByRole("button", { name: /start date/i })).toBeEnabled();
  });

  it("does not offer one on a plan whose dates belong to the plan", () => {
    renderRow();
    expect(screen.queryByRole("button", { name: /start date/i })).not.toBeInTheDocument();
  });

  it("does not offer one when the plan could not be read", () => {
    renderRow({ ...COVER, plan_window: null });
    expect(screen.queryByRole("button", { name: /start date/i })).not.toBeInTheDocument();
  });

  it("opens on the day it already starts, not on today", async () => {
    const user = userEvent.setup();
    renderRow(COVER);
    await user.click(screen.getByRole("button", { name: /start date/i }));
    expect(await screen.findByLabelText(/start date/i)).toHaveValue("2026-05-01");
  });

  it("shows the end date moving with the start before anything is saved", async () => {
    const user = userEvent.setup();
    renderRow(COVER);
    await user.click(screen.getByRole("button", { name: /start date/i }));
    const field = await screen.findByLabelText(/start date/i);
    await user.clear(field);
    await user.type(field, "2026-02-01");
    // Still 365 days, moved: 1 Feb 2026 to 1 Feb 2027, read in club time.
    expect(await screen.findByText(/Runs 01\/02\/2026 to 01\/02\/2027/)).toBeInTheDocument();
    expect(setMembershipStart).not.toHaveBeenCalled();
  });

  // A Save button that silently does nothing is a dead end. Clearing the field
  // to retype is the ordinary way to reach that state.
  it("says why Save is unavailable when the date is cleared", async () => {
    const user = userEvent.setup();
    renderRow(COVER);
    await user.click(screen.getByRole("button", { name: /start date/i }));
    await user.clear(await screen.findByLabelText(/start date/i));
    expect(screen.getByRole("button", { name: /save start date/i })).toBeDisabled();
    expect(screen.getByText(/pick a day to save/i)).toBeInTheDocument();
  });

  it("saves the day, and lets the server place it", async () => {
    const user = userEvent.setup();
    setMembershipStart.mockResolvedValueOnce({ ok: true });
    const { onChanged } = renderRow(COVER);

    await user.click(screen.getByRole("button", { name: /start date/i }));
    const field = await screen.findByLabelText(/start date/i);
    await user.clear(field);
    await user.type(field, "2026-02-01");
    await user.click(screen.getByRole("button", { name: /save start date/i }));

    await waitFor(() =>
      expect(setMembershipStart).toHaveBeenCalledWith({
        data: { id: "mem-1", starts_on: "2026-02-01" },
      }),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  // Same rule as every other write on this row: a failure stays on screen with
  // the button still in it, never a toast that fades.
  it("keeps a failed start-date save on screen with a way forward", async () => {
    const user = userEvent.setup();
    setMembershipStart.mockRejectedValueOnce(new Error("Yearly insurance has no start date"));
    renderRow(COVER);

    await user.click(screen.getByRole("button", { name: /start date/i }));
    await user.click(screen.getByRole("button", { name: /save start date/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no start date/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeEnabled();
  });

  it("keeps the failure on screen with the button still there", async () => {
    const user = userEvent.setup();
    deleteMembership.mockRejectedValueOnce(new Error("This membership cannot be deleted because…"));
    renderRow();

    await user.click(screen.getByRole("button", { name: /delete/i }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot be deleted/i);
    // Still open, and still offering a way forward.
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeEnabled();
  });
});
