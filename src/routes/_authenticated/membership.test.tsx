// The point of the "how to pay" panel is that a member never has to go back to
// their inbox to pay, so what is pinned here is the panel's content: the amount
// they owe, the reference that reconciles it, the club's account details, and
// the fact that a bundle is ONE transfer rather than two. The email still goes
// out unchanged; these are the same numbers, on the page.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const PLAN_REF = "UTSJ-LOVE-A1B2";

const pendingPlan = {
  id: "m1",
  plan_code: "2026-s2",
  plan_name: "Semester 2 2026",
  kind: "period",
  status: "pending",
  is_student: false,
  price_cents: 24500,
  payment_reference: PLAN_REF,
  payment_method: "bank_transfer",
  paid_at: null,
  starts_at: null,
  ends_at: null,
  sessions_remaining: null,
  session_date: null,
  created_at: "2026-08-01T00:00:00Z",
};
const pendingInsurance = {
  ...pendingPlan,
  id: "m2",
  plan_code: "insurance_yearly",
  plan_name: "Yearly insurance",
  kind: "insurance",
  price_cents: 6000,
};
const activePlan = { ...pendingPlan, id: "m3", status: "active", paid_at: "2026-08-02T00:00:00Z" };

const getMyMemberships = vi.fn();
const getPaymentInstructions = vi.fn();

function mine(memberships: unknown[]) {
  return {
    lifecycle: "visitor",
    memberships,
    uts_student_number: null,
    sessions_attended: 0,
  };
}

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/membership.functions", () => ({
  listMembershipPlans: vi.fn().mockResolvedValue([]),
  getMyMemberships: (...args: unknown[]) => getMyMemberships(...args),
  getPaymentInstructions: (...args: unknown[]) => getPaymentInstructions(...args),
  startMembership: vi.fn(),
}));

vi.mock("@/lib/code-of-conduct.functions", () => ({
  getCodeOfConductSigner: vi.fn().mockResolvedValue({ status: null }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const { Route } = await import("./membership");
const MembershipPage = (Route as unknown as { component: () => ReactNode }).component;

/** The "how to pay" card, or null when the page is not showing one. */
function payCard(): HTMLElement | null {
  const title = screen.queryByText("How to pay");
  return title ? (title.closest("div.rounded-xl") as HTMLElement) : null;
}

async function renderLoaded() {
  render(<MembershipPage />);
  await waitFor(() => expect(screen.getByRole("heading", { name: "Membership" })).toBeVisible());
}

beforeEach(() => {
  getMyMemberships.mockReset().mockResolvedValue(mine([pendingPlan]));
  getPaymentInstructions
    .mockReset()
    .mockResolvedValue({ instructions: "Pay **UTS Jitsu Club**, BSB 062-000, acct 1234 5678." });
});

describe("/membership: how to pay", () => {
  it("shows the amount, the reference and the club's account details", async () => {
    await renderLoaded();
    const card = payCard()!;
    expect(card).toBeInTheDocument();
    expect(within(card).getByText("$245")).toBeVisible();
    expect(within(card).getByText(PLAN_REF)).toBeVisible();
    // The markdown a manager wrote at /manager/settings, rendered — this is the
    // half that used to exist only in the invoice email.
    expect(within(card).getByText(/BSB 062-000, acct 1234 5678/)).toBeVisible();
    expect(within(card).getByText("UTS Jitsu Club")).toBeVisible();
  });

  it("renders the instructions as markdown, bullets and all", async () => {
    // Not with `prose` classes: this repo has no typography plugin, so a set of
    // bank details written as a list would otherwise render as one run-on line.
    getPaymentInstructions.mockResolvedValue({
      instructions: "Pay to:\n\n- BSB: 062-000\n- Account: 1234 5678",
    });
    await renderLoaded();
    const card = payCard()!;
    expect(within(card).getByRole("list").className).toContain("list-disc");
    expect(within(card).getAllByRole("listitem")).toHaveLength(2);
  });

  it("copies the reference, which is what a bank transfer reconciles on", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await renderLoaded();
    await userEvent.click(within(payCard()!).getByRole("button", { name: /copy reference/i }));
    expect(writeText).toHaveBeenCalledWith(PLAN_REF);
  });

  it("bills a bundled plan + insurance as one transfer, and shows the split", async () => {
    // Two memberships, one reference: paying half of it against that reference
    // would reconcile neither, so the member must be shown a single total.
    getMyMemberships.mockResolvedValue(mine([pendingPlan, pendingInsurance]));
    await renderLoaded();
    const card = payCard()!;
    expect(within(card).getByText("$305")).toBeVisible();
    expect(within(card).getAllByText(PLAN_REF)).toHaveLength(1);
    expect(within(card).getByText("Semester 2 2026 + Yearly insurance")).toBeVisible();
    // The split, so the total does not read as a wrong price for the plan.
    expect(within(card).getByText("$60")).toBeVisible();
  });

  it("bills two separate references as two transfers", async () => {
    getMyMemberships.mockResolvedValue(
      mine([pendingPlan, { ...pendingInsurance, payment_reference: "UTSJ-LOVE-C3D4" }]),
    );
    await renderLoaded();
    const card = payCard()!;
    expect(within(card).getByText(PLAN_REF)).toBeVisible();
    expect(within(card).getByText("UTSJ-LOVE-C3D4")).toBeVisible();
    expect(within(card).getAllByRole("button", { name: /copy reference/i })).toHaveLength(2);
  });

  it("says nothing about paying when nothing is owed", async () => {
    getMyMemberships.mockResolvedValue(mine([activePlan]));
    await renderLoaded();
    expect(payCard()).toBeNull();
  });

  it("keeps the amount and reference when the club's details fail to load", async () => {
    // The member's own invoice is already loaded; only the club's account
    // details are missing, so the panel degrades rather than disappearing.
    vi.spyOn(console, "error").mockImplementation(() => {});
    getPaymentInstructions.mockRejectedValue(new Error("nope"));
    await renderLoaded();
    const card = payCard()!;
    expect(within(card).getByText("$245")).toBeVisible();
    expect(within(card).getByText(PLAN_REF)).toBeVisible();
    expect(within(card).getByText(/invoice email we sent you/)).toBeVisible();
    vi.restoreAllMocks();
  });
});
