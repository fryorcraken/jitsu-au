// `PlanCard` used to be declared *inside* `PlansPage`'s function body, so every
// `patch()` -> `setPlans()` re-render handed React a brand-new component type
// for every card, remounting them all and stealing focus mid-type — the same
// class of bug `manager.blog_.new.test.tsx` already pins for the blog editor.
// A manager could type exactly one character into a plan's Name field before
// losing focus. This test fails on that regression: `userEvent.type` keeps
// dispatching to the DOM node it first found, so if the card remounts under
// it, only the first keystroke reaches the (now-detached) old node and the
// rest are lost.
import { render, screen, waitFor, within } from "@testing-library/react";
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

/** Still flagged available, but its dates have passed — so it lands under
 * "Not on sale" with its "Available to buy" box ticked. That pair reads as a
 * contradiction unless the card explains which one wins. */
const ENDED_PLAN = {
  ...PLAN,
  id: "plan-2",
  code: "semester_1_2026",
  name: "Semester 1 2026",
  starts_on: "2026-02-02",
  ends_on: "2026-06-12",
  is_active: true,
};

/** The shape the new migration deletes: a training period that never got its
 * dates. Reachable today via the manager agent API, which the DB still allows. */
const MALFORMED_PLAN = {
  ...PLAN,
  id: "plan-3",
  code: "semester",
  name: "One semester",
  starts_on: null,
  ends_on: null,
  is_active: true,
};

vi.mock("@/lib/membership.functions", () => ({
  listAllMembershipPlans: vi.fn().mockResolvedValue([PLAN, ENDED_PLAN, MALFORMED_PLAN]),
  saveMembershipPlan: (...args: unknown[]) => saveMembershipPlan(...args),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (m: string) => toastError(m), success: vi.fn() },
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

  /** Each card and the Add form render the same four labels, so pick the
   * radio belonging to one specific group. */
  const radioIn = (group: string, label: RegExp) =>
    screen.getAllByRole("radio", { name: label }).find((el) => el.getAttribute("name") === group)!;

  // The plan type used to be *derived* from whether the date fields were
  // filled in, while picking an option blanked all of them. So choosing
  // "Training period" immediately looked like "no dates set", the selection
  // snapped back to the credits option, and the date inputs never rendered:
  // two of the three choices were literally unclickable. The type is now the
  // plan's stored `kind`, which nothing else can overwrite.
  describe("plan type picker", () => {
    it("selects Training period on the Add form and reveals its date fields", async () => {
      const user = userEvent.setup();
      render(<PlansPage />);
      await screen.findByLabelText("Name", { selector: "#new-plan-name" });

      // The Add form starts on Training period, so move away and back: this is
      // the exact sequence that used to make the option unselectable.
      await user.click(radioIn("new-plan-plan-type", /casual class/i));
      const period = radioIn("new-plan-plan-type", /training period/i);
      await user.click(period);

      expect(period).toBeChecked();
      expect(screen.getByLabelText("Starts", { selector: "#new-plan-starts" })).toBeInTheDocument();
      expect(screen.getByLabelText("Ends", { selector: "#new-plan-ends" })).toBeInTheDocument();
    });

    it("keeps a date typed into a Training period plan instead of clearing it", async () => {
      const user = userEvent.setup();
      render(<PlansPage />);
      await screen.findByLabelText("Name", { selector: "#new-plan-name" });

      await user.click(radioIn("new-plan-plan-type", /training period/i));
      const starts = screen.getByLabelText("Starts", { selector: "#new-plan-starts" });
      await user.type(starts, "2027-02-01");

      expect(starts).toHaveValue("2027-02-01");
      expect(radioIn("new-plan-plan-type", /training period/i)).toBeChecked();
    });

    it("switches an existing dated plan to Yearly insurance, swapping dates for a day count", async () => {
      const user = userEvent.setup();
      render(<PlansPage />);

      await screen.findByLabelText("Name", { selector: "#plan-plan-1-name" });
      const planInsurance = radioIn("plan-plan-1-plan-type", /yearly insurance/i);
      await user.click(planInsurance);

      expect(planInsurance).toBeChecked();
      // Dates are gone, replaced by the 365-day default.
      expect(screen.queryByLabelText("Starts", { selector: "#plan-plan-1-starts" })).toBeNull();
      expect(
        screen.getByLabelText("Days from payment", { selector: "#plan-plan-1-duration" }),
      ).toHaveValue("365");
    });

    it("hides session credits for insurance, since insurance never covers mat time", async () => {
      const user = userEvent.setup();
      render(<PlansPage />);

      expect(
        await screen.findByLabelText("Session credits", { selector: "#plan-plan-1-credits" }),
      ).toBeInTheDocument();

      await user.click(radioIn("plan-plan-1-plan-type", /yearly insurance/i));

      expect(
        screen.queryByLabelText("Session credits", { selector: "#plan-plan-1-credits" }),
      ).toBeNull();
    });

    it("does not call blank credits unlimited on a credit-run plan, where it would never run out", async () => {
      const user = userEvent.setup();
      render(<PlansPage />);
      await screen.findByLabelText("Name", { selector: "#plan-plan-1-name" });

      await user.click(radioIn("plan-plan-1-plan-type", /casual class/i));

      expect(
        screen.getByLabelText("Session credits", { selector: "#plan-plan-1-credits" }),
      ).toHaveAttribute("placeholder", "how many classes");
    });

    it("refuses to save a credit-run plan with no credits", async () => {
      const user = userEvent.setup();
      render(<PlansPage />);
      await screen.findByLabelText("Name", { selector: "#plan-plan-1-name" });
      toastError.mockClear();
      saveMembershipPlan.mockClear();

      // period (dates, no credits) -> session clears the dates, leaving a plan
      // that would never expire AND match no check-in coverage tier.
      await user.click(radioIn("plan-plan-1-plan-type", /casual class/i));
      await user.click(screen.getAllByRole("button", { name: "Save" })[0]);

      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/never run out/i));
      expect(saveMembershipPlan).not.toHaveBeenCalled();
    });

    it("labels blank session credits as unlimited rather than none", async () => {
      render(<PlansPage />);

      expect(
        await screen.findByLabelText("Session credits", { selector: "#plan-plan-1-credits" }),
      ).toHaveAttribute("placeholder", "unlimited");
    });
  });

  it("explains why an ended plan is off sale despite being ticked available", async () => {
    render(<PlansPage />);

    // The date is interpolated, so the sentence spans several text nodes.
    expect(
      await screen.findByText((_t, el) =>
        Boolean(
          el?.textContent?.includes(
            "Ended 12/06/2026, so it is not for sale whatever this is set to.",
          ) && el.children.length === 0,
        ),
      ),
    ).toBeInTheDocument();
    // The ended card's OWN tick stays on and editable, so a manager can still
    // tidy up. Asserting "some tick is checked" would pass on the active plan.
    const endedCard = document.querySelector('[data-plan="plan-2"]') as HTMLElement;
    expect(within(endedCard).getByRole("checkbox", { name: /available to buy/i })).toHaveAttribute(
      "data-state",
      "checked",
    );
  });

  // A dateless training period activates to `ends_at: null` and still passes
  // `sellablePlans`, i.e. a membership that never expires. That is exactly
  // what the deleted "One semester" plan was, and "Duplicate" clears the
  // dates, so it stays one careless click away without this guard.
  it("refuses to add a training period with no dates", async () => {
    const user = userEvent.setup();
    render(<PlansPage />);
    toastError.mockClear();
    saveMembershipPlan.mockClear();

    await user.type(
      await screen.findByLabelText("Code", { selector: "#new-plan-code" }),
      "semester_1_2027",
    );
    await user.type(
      screen.getByLabelText("Name", { selector: "#new-plan-name" }),
      "Semester 1 2027",
    );
    await user.type(
      screen.getByLabelText("Public price ($)", { selector: "#new-plan-public-price" }),
      "445",
    );
    await user.click(screen.getByRole("button", { name: "Add plan" }));

    expect(toastError).toHaveBeenCalledWith(
      "A training period needs both a start and an end date.",
    );
    expect(saveMembershipPlan).not.toHaveBeenCalled();
  });

  // A row can arrive malformed (written by the manager agent API, or predating
  // these rules). Holding the shape guard over an edit that does not touch the
  // shape would trap a manager: the obvious remedy, taking it off sale, would
  // itself be refused.
  it("lets an already-malformed plan be taken off sale without fixing its shape first", async () => {
    const user = userEvent.setup();
    render(<PlansPage />);
    await screen.findByLabelText("Name", { selector: "#plan-plan-3-name" });
    toastError.mockClear();
    saveMembershipPlan.mockClear();

    const card = () => document.querySelector('[data-plan="plan-3"]') as HTMLElement;
    await user.click(within(card()).getByRole("checkbox", { name: /available to buy/i }));
    // Unticking moves the card into the collapsed "Not on sale" section, which
    // remounts it — so re-query rather than reusing the detached node.
    await user.click(within(card()).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveMembershipPlan).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalled();
  });

  describe("Save button", () => {
    it("is greyed out until something changes, and again once saved", async () => {
      const user = userEvent.setup();
      saveMembershipPlan.mockClear();
      render(<PlansPage />);

      const nameField = await screen.findByLabelText("Name", { selector: "#plan-plan-1-name" });
      const saveButton = screen.getAllByRole("button", { name: "Save" })[0];
      expect(saveButton).toBeDisabled();

      await user.type(nameField, "!");
      expect(saveButton).toBeEnabled();

      await user.click(saveButton);
      await waitFor(() => expect(saveMembershipPlan).toHaveBeenCalled());
      await waitFor(() => expect(saveButton).toBeDisabled());
    });

    it("re-enables after an edit is reverted back and forth", async () => {
      const user = userEvent.setup();
      render(<PlansPage />);

      const nameField = await screen.findByLabelText("Name", { selector: "#plan-plan-1-name" });
      const saveButton = screen.getAllByRole("button", { name: "Save" })[0];

      await user.type(nameField, "x");
      expect(saveButton).toBeEnabled();

      // Typing back to the stored value is not a change, so Save greys out.
      await user.keyboard("{Backspace}");
      expect(saveButton).toBeDisabled();
    });
  });
});
