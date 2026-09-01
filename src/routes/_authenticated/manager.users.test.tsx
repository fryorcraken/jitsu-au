// The directory is one row per person across the whole funnel, and only one of
// those phases can be deleted from here: a lead, who signed nothing and owes
// nothing. Everybody else has a waiver, a membership or attendance behind them,
// and what the club may destroy of that is still an open product question.
// So the test that matters is the negative one: the button is not drawn on a
// person's row, whatever else changes about this screen.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const listClubUsers = vi.fn();
const markInterestRegistrationsSeen = vi.fn();
const deleteLead = vi.fn();

const lead = {
  user_id: null,
  name: "Sam Lee",
  greeting_name: null,
  email: "sam@example.com",
  email_confirmed_at: null,
  phone: "0400 000 111",
  roles: [] as string[],
  lifecycle_status: "lead" as const,
  has_waiver: false,
  waiver_signed_at: null,
  is_uts_student: false,
  uts_student_number: null,
  gi_size: null,
  belt_size: null,
  latest_plan_name: null,
  latest_plan_kind: null,
  latest_membership_status: null,
  latest_sessions_remaining: null,
  membership_count: 0,
  sessions_attended: 0,
  first_seen_at: "2026-08-05T10:00:00.000Z",
};
const member = {
  ...lead,
  user_id: "user-1",
  name: "Kim Tran",
  email: "kim@example.com",
  email_belongs_to: null as string | null,
  lifecycle_status: "member" as const,
  has_waiver: true,
  waiver_signed_at: "2026-07-01T00:00:00.000Z",
};
// A child on their parent's account. They have no mailbox of their own, so the
// address on their row is the parent's.
const dependant = {
  ...member,
  user_id: "user-2",
  name: "Bea Tran",
  email: "kim@example.com",
  email_belongs_to: "Kim Tran",
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/membership.functions", () => ({
  listClubUsers: (...args: unknown[]) => listClubUsers(...args),
}));

vi.mock("@/lib/leads.functions", () => ({
  markInterestRegistrationsSeen: (...args: unknown[]) => markInterestRegistrationsSeen(...args),
  deleteLead: (...args: unknown[]) => deleteLead(...args),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "manager-1" }, session: null, loading: false }),
  useRoles: () => ({ roles: ["manager"], loading: false, isManager: true }),
}));

vi.mock("@/hooks/useNotifications", () => ({
  useNotifications: () => ({ refresh: vi.fn() }),
}));

const { Route } = await import("./manager.users");
const ManagerUsersPage = (Route as unknown as { component: () => ReactNode }).component;

async function renderLoaded() {
  render(<ManagerUsersPage />);
  await screen.findByRole("table");
}

beforeEach(() => {
  listClubUsers.mockReset().mockResolvedValue([lead, member]);
  markInterestRegistrationsSeen.mockReset().mockResolvedValue({ ok: true, newEmails: [] });
  deleteLead.mockReset().mockResolvedValue({ ok: true, deleted: 1 });
});

describe("/manager/users", () => {
  it("says whose address a child's row is showing", async () => {
    // The whole point of the split. Printed bare under "Bea Tran", this
    // address reads as a nine-year-old's mailbox, and a manager writes to it.
    // The caption is the half that makes it honest, and nothing else pins it.
    listClubUsers.mockResolvedValue([member, dependant]);
    await renderLoaded();

    const row = screen.getByText("Bea Tran").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("(Kim Tran's)")).toBeInTheDocument();
  });

  it("leaves an account holder's own address uncaptioned", async () => {
    // Almost every row. A caption on all of them would be noise, and would
    // stop the ones that matter standing out.
    listClubUsers.mockResolvedValue([member, dependant]);
    await renderLoaded();

    const row = screen.getByText("Kim Tran").closest("tr");
    expect(within(row as HTMLElement).queryByText(/'s\)/)).toBeNull();
  });

  it("offers no delete for someone the club has a record for", async () => {
    await renderLoaded();
    expect(screen.queryByRole("button", { name: /Delete the enquiry from Kim Tran/ })).toBeNull();
  });

  it("deletes nothing until the manager confirms", async () => {
    await renderLoaded();
    await userEvent.click(screen.getByRole("button", { name: "Delete the enquiry from Sam Lee" }));

    expect(deleteLead).not.toHaveBeenCalled();
    expect(screen.getByText("Sam Lee")).toBeInTheDocument();
  });

  it("names the address, and says the contact inbox is separate", async () => {
    await renderLoaded();
    await userEvent.click(screen.getByRole("button", { name: "Delete the enquiry from Sam Lee" }));

    const dialog = within(await screen.findByRole("alertdialog"));
    expect(dialog.getByText(/Delete the enquiry from Sam Lee\?/)).toBeInTheDocument();
    // A manager pressing this is entitled to think it removes everything about
    // the person. It does not: their contact-form messages live in another
    // inbox, and the confirm has to say so before the click, not after.
    //
    // Pinned as "does not touch it" rather than a looser match on the inbox's
    // name. The first wording here read "...is separate, and is deleted from
    // Contact messages", which says the opposite of what the code does, and a
    // test matching only /deleted from Contact messages/ passed on it happily.
    // A confirm for something irreversible is wrong if it merely mentions the
    // right nouns, so assert the claim, not the vocabulary.
    expect(dialog.getByText(/does not touch it/)).toBeVisible();
    expect(dialog.getByText(/stays in Contact messages until you delete it there/)).toBeVisible();
  });

  it("takes the lead off the list once the server confirms", async () => {
    await renderLoaded();
    await userEvent.click(screen.getByRole("button", { name: "Delete the enquiry from Sam Lee" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );

    expect(deleteLead).toHaveBeenCalledWith({ data: { email: "sam@example.com" } });
    expect(screen.queryByText("Sam Lee")).toBeNull();
    expect(screen.getByText("Kim Tran")).toBeInTheDocument();
  });

  it("keeps the lead listed when the server refuses", async () => {
    deleteLead.mockRejectedValue(new Error("That address belongs to someone the club has..."));
    await renderLoaded();
    await userEvent.click(screen.getByRole("button", { name: "Delete the enquiry from Sam Lee" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );

    // The likeliest refusal is that they signed a waiver since the page loaded.
    // Their enquiry is still on file, so the row stays.
    expect(await screen.findByText("Sam Lee")).toBeInTheDocument();
  });
});
