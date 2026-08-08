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

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/membership.functions", () => ({
  setMembershipStatus: (...args: unknown[]) => setMembershipStatus(...args),
  deleteMembership: (...args: unknown[]) => deleteMembership(...args),
}));

const { MembershipRowActions } = await import("./MembershipRowActions");
type Row = import("./MembershipRowActions").MembershipActionRow;

/** A pending invoice nobody paid or trained on: the tidy-up case. */
const JUNK: Row = {
  id: "mem-1",
  status: "pending",
  paid_at: null,
  price_cents: 44500,
  checkin_count: 0,
  plan_name: "Semester 2 2026",
};

function renderRow(overrides: Partial<Row> = {}, onChanged = vi.fn().mockResolvedValue(1)) {
  render(<MembershipRowActions membership={{ ...JUNK, ...overrides }} onChanged={onChanged} />);
  return { onChanged };
}

describe("MembershipRowActions", () => {
  // The bug this whole change starts from: the only button on a pending row was
  // Activate, so cancelling one meant activating it first, which emails the
  // member that their membership is live.
  it("offers Cancel on a pending membership, with no activation first", () => {
    renderRow();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeEnabled();
  });

  it("offers Cancel on an active membership but not Activate", () => {
    renderRow({ status: "active", paid_at: "2026-08-01T00:00:00Z" });
    expect(screen.getByRole("button", { name: /cancel/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /activate/i })).not.toBeInTheDocument();
  });

  it("does not offer Cancel on one already cancelled", () => {
    renderRow({ status: "cancelled" });
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
  });

  it("allows deleting a pending invoice nobody paid or trained on", () => {
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

  // Activation stamps `paid_at` on the $0 free trial too, and the trial is
  // auto-assigned at waiver approval — so this is the row a manager most often
  // wants gone. Reading that stamp as a payment would lock it forever.
  it("still allows deleting an activated free trial nobody used", () => {
    renderRow({
      status: "cancelled",
      paid_at: "2026-08-01T00:00:00Z",
      price_cents: 0,
      plan_name: "Free trial",
    });
    expect(screen.getByRole("button", { name: /delete/i })).toBeEnabled();
  });

  // A disabled button with a hover-only reason is a dead end on a phone, where
  // there is no hover. The reason is in the accessibility tree either way.
  it("names every blocker at once rather than the first", () => {
    renderRow({ status: "active", checkin_count: 1 });
    const reason = screen.getByText(/cannot be deleted/i);
    expect(reason).toHaveTextContent(/still active/i);
    expect(reason).toHaveTextContent(/checked in against it/i);
  });

  it("says what cancelling will do before it happens", async () => {
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      /lose the members-only calendar/i,
    );
  });

  it("cancels only after the confirm, then reloads the caller's data", async () => {
    const user = userEvent.setup();
    setMembershipStatus.mockResolvedValueOnce({ ok: true });
    const { onChanged } = renderRow();

    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(setMembershipStatus).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /cancel membership/i }));
    await waitFor(() =>
      expect(setMembershipStatus).toHaveBeenCalledWith({
        data: { id: "mem-1", status: "cancelled" },
      }),
    );
    expect(onChanged).toHaveBeenCalled();
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
