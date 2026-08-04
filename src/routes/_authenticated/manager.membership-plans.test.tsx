// `PlanCard` used to be declared *inside* `PlansPage`'s function body, so every
// `patch()` -> `setPlans()` re-render handed React a brand-new component type
// for every card, remounting them all and stealing focus mid-type — the same
// class of bug `manager.blog_.new.test.tsx` already pins for the blog editor.
// A manager could type exactly one character into a plan's Name field before
// losing focus. This test fails on that regression: `userEvent.type` keeps
// dispatching to the DOM node it first found, so if the card remounts under
// it, only the first keystroke reaches the (now-detached) old node and the
// rest are lost.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const saveMembershipPlan = vi.fn().mockResolvedValue({ ok: true, id: "plan-1" });

const PLAN = {
  id: "plan-1",
  code: "semester_2_2026",
  name: "Semester 2 2026",
  description: "Unlimited classes",
  kind: "period",
  public_price_cents: 44500,
  student_price_cents: 24500,
  duration_days: null,
  session_credits: null,
  is_active: true,
  sort_order: 2,
  starts_on: "2026-07-20",
  ends_on: "2026-11-22",
  created_at: "2026-01-01T00:00:00Z",
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/membership.functions", () => ({
  listAllMembershipPlans: vi.fn().mockResolvedValue([PLAN]),
  saveMembershipPlan: (...args: unknown[]) => saveMembershipPlan(...args),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "manager-1" }, session: null, loading: false }),
  useRoles: () => ({ roles: ["manager"], loading: false, isManager: true }),
}));

const { Route } = await import("./manager.membership-plans");
const PlansPage = (Route as unknown as { component: () => ReactNode }).component;

describe("/manager/membership-plans", () => {
  it("keeps typed text in an existing plan's Name field instead of resetting it on every keystroke", async () => {
    const user = userEvent.setup();
    render(<PlansPage />);

    const nameField = await screen.findByLabelText("Name", { selector: "#plan-plan-1-name" });
    await user.type(nameField, " renamed");

    expect(nameField).toHaveValue("Semester 2 2026 renamed");
  });

  it("keeps typed text in the Add-a-plan Name field", async () => {
    const user = userEvent.setup();
    render(<PlansPage />);

    const nameField = await screen.findByLabelText("Name", { selector: "#new-plan-name" });
    await user.type(nameField, "Semester 1 2027");

    expect(nameField).toHaveValue("Semester 1 2027");
  });
});
