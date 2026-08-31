// "People on your account". The card that makes a family visible on a page
// that, before it, showed a parent no sign that their children existed at all.
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const listMyHousehold = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));

vi.mock("@/lib/household.functions", () => ({
  listMyHousehold: (...args: unknown[]) => listMyHousehold(...args),
}));

const { HouseholdCard } = await import("./HouseholdCard");

const PARENT = {
  user_id: "parent-1",
  name: "Ada Lovelace",
  is_self: true,
  lifecycle_status: "member" as const,
  has_any_waiver: true,
  latest_plan_name: "One semester",
  latest_plan_kind: "period",
  latest_membership_status: "active" as const,
  latest_sessions_remaining: null,
};

const CHILD = {
  user_id: "child-1",
  name: "Bea Lovelace",
  is_self: false,
  lifecycle_status: "visitor" as const,
  has_any_waiver: true,
  latest_plan_name: "Free trial",
  latest_plan_kind: "trial",
  latest_membership_status: "active" as const,
  latest_sessions_remaining: 2,
};

beforeEach(() => vi.clearAllMocks());

describe("an account with nobody else on it", () => {
  it("renders nothing at all", async () => {
    // Almost every account. "People on your account: you" tells a member
    // nothing and pushes the details they came for further down the page.
    listMyHousehold.mockResolvedValue([PARENT]);
    const { container } = render(<HouseholdCard userId="parent-1" />);
    await waitFor(() => expect(listMyHousehold).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe("a parent with a child", () => {
  it("lists the child, their phase and where their membership stands", async () => {
    listMyHousehold.mockResolvedValue([PARENT, CHILD]);
    render(<HouseholdCard userId="parent-1" />);

    expect(await screen.findByText("Bea Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Free trial: active")).toBeInTheDocument();
  });

  it("lists the parent too, because they have a waiver of their own", async () => {
    listMyHousehold.mockResolvedValue([PARENT, CHILD]);
    render(<HouseholdCard userId="parent-1" />);

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("(you)")).toBeInTheDocument();
  });

  it("leaves a parent who never trains off the list", async () => {
    // They have no waiver, no membership and no photo consent, so a row for
    // them would invite a click through to an empty page.
    listMyHousehold.mockResolvedValue([
      { ...PARENT, has_any_waiver: false, latest_plan_name: null, latest_membership_status: null },
      CHILD,
    ]);
    render(<HouseholdCard userId="parent-1" />);

    expect(await screen.findByText("Bea Lovelace")).toBeInTheDocument();
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
  });

  it("says a child has no membership rather than leaving the line blank", async () => {
    listMyHousehold.mockResolvedValue([
      PARENT,
      { ...CHILD, latest_plan_name: null, latest_plan_kind: null, latest_membership_status: null },
    ]);
    render(<HouseholdCard userId="parent-1" />);

    expect(await screen.findByText("No membership yet")).toBeInTheDocument();
  });
});

describe("when the read fails", () => {
  it("says so and offers a retry, rather than showing an empty account", async () => {
    // Rendered as an empty card this would tell a parent their children are
    // gone, which is the one thing it must never say.
    listMyHousehold.mockRejectedValue(new Error("Failed to fetch"));
    render(<HouseholdCard userId="parent-1" />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/not the same as having nobody on it/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});
