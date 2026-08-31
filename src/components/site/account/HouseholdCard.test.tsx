// "People on your account". The card that makes a family visible on a page
// that, before it, showed a parent no sign that their children existed at all.
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
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

const retry = vi.fn();

beforeEach(() => vi.clearAllMocks());

/** Render the card the way `/account` does, with the fetch already done. */
function show(people: unknown[], loadError: string | null = null) {
  return render(<HouseholdCard people={people as never} loadError={loadError} onRetry={retry} />);
}

describe("an account with nobody else on it", () => {
  it("renders nothing at all", () => {
    // Almost every account. "People on your account: you" tells a member
    // nothing and pushes the details they came for further down the page.
    const { container } = show([PARENT]);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("a parent with a child", () => {
  it("lists the child, their phase and where their membership stands", () => {
    show([PARENT, CHILD]);

    expect(screen.getByText("Bea Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Free trial: active")).toBeInTheDocument();
  });

  it("lists the parent too, because they have a waiver of their own", () => {
    show([PARENT, CHILD]);

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("(you)")).toBeInTheDocument();
  });

  it("leaves a parent who never trains off the list", () => {
    // They have no waiver, no membership and no photo consent, so a row for
    // them would invite a click through to an empty page.
    show([
      { ...PARENT, has_any_waiver: false, latest_plan_name: null, latest_membership_status: null },
      CHILD,
    ]);

    expect(screen.getByText("Bea Lovelace")).toBeInTheDocument();
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
  });

  it("says a child has no membership rather than leaving the line blank", () => {
    show([
      PARENT,
      { ...CHILD, latest_plan_name: null, latest_plan_kind: null, latest_membership_status: null },
    ]);

    expect(screen.getByText("No membership yet")).toBeInTheDocument();
  });
});

describe("when the read fails", () => {
  it("says so and offers a retry, rather than showing an empty account", () => {
    // Rendered as an empty card this would tell a parent their children are
    // gone, which is the one thing it must never say.
    show([], "We could not reach the server.");

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/not the same as having nobody on it/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});
