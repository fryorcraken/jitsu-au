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
const listMembershipPlans = vi.fn();
const startMembership = vi.fn();
const toastSuccess = vi.fn();

const FREE_PLAN = {
  code: "open_mat",
  name: "Open mat",
  description: null,
  kind: "session",
  public_price_cents: 0,
  student_price_cents: null,
  session_credits: 1,
  starts_on: null,
  ends_on: null,
  duration_days: null,
  is_active: true,
};

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
  listMembershipPlans: (...args: unknown[]) => listMembershipPlans(...args),
  getMyMemberships: (...args: unknown[]) => getMyMemberships(...args),
  getPaymentInstructions: (...args: unknown[]) => getPaymentInstructions(...args),
  startMembership: (...args: unknown[]) => startMembership(...args),
}));

vi.mock("@/lib/code-of-conduct.functions", () => ({
  getCodeOfConductSigner: vi.fn().mockResolvedValue({ status: null }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: (...args: unknown[]) => toastSuccess(...args) },
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

/** The club's account as the server hands it over: BSB stored as bare digits. */
const ACCOUNT = {
  account_name: "UTS Jitsu Club Inc",
  bsb: "062000",
  account_number: "12345678",
  bank_name: "Commonwealth Bank of Australia",
  swift_bic: "CTBAAU2S",
  bank_address: "Sydney NSW 2000, Australia",
  account_holder_address: "1 Broadway, Ultimo NSW 2007",
  note: "",
};

beforeEach(() => {
  getMyMemberships.mockReset().mockResolvedValue(mine([pendingPlan]));
  getPaymentInstructions.mockReset().mockResolvedValue({ ok: true, details: ACCOUNT });
  listMembershipPlans.mockReset().mockResolvedValue([]);
  startMembership.mockReset().mockResolvedValue({ ok: true, activated: true, reference: null });
  toastSuccess.mockReset();
});

describe("/membership: how to pay", () => {
  it("shows the amount, the reference and the club's account", async () => {
    await renderLoaded();
    const card = payCard()!;
    expect(card).toBeInTheDocument();
    expect(within(card).getByText("$245")).toBeVisible();
    expect(within(card).getByText(PLAN_REF)).toBeVisible();
    expect(within(card).getByText("UTS Jitsu Club Inc")).toBeVisible();
    // Stored as six digits, shown the way a bank prints it.
    expect(within(card).getByText("062-000")).toBeVisible();
    expect(within(card).getByText("12345678")).toBeVisible();
    expect(within(card).getByText("Commonwealth Bank of Australia")).toBeVisible();
  });

  // A regression in any one of these sends somebody's money to the wrong place,
  // so each button is pinned to the exact string it puts on the clipboard.
  it("copies each field on its own, the BSB hyphenated as displayed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await renderLoaded();
    const card = within(payCard()!);

    for (const [name, expected] of [
      [/copy reference/i, PLAN_REF],
      [/copy account name/i, "UTS Jitsu Club Inc"],
      [/copy BSB/i, "062-000"],
      [/copy account number/i, "12345678"],
      [/copy bank name/i, "Commonwealth Bank of Australia"],
    ] as const) {
      writeText.mockClear();
      await userEvent.click(card.getByRole("button", { name }));
      expect(writeText).toHaveBeenCalledWith(expected);
    }
  });

  it("keeps the overseas details out of the way until someone opens them", async () => {
    await renderLoaded();
    const card = within(payCard()!);
    const disclosure = screen.getByText("Paying from overseas?").closest("details")!;
    expect(disclosure.open).toBe(false);
    // Present in the DOM but collapsed, which is what <details> gives us for
    // free and what keeps it findable by in-page search.
    expect(card.getByText("CTBAAU2S")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Paying from overseas?"));
    expect(disclosure.open).toBe(true);
    expect(card.getByText(/take fees out of an international transfer/i)).toBeVisible();
  });

  it("copies the SWIFT/BIC code, which is what an overseas bank needs", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await renderLoaded();
    await userEvent.click(within(payCard()!).getByRole("button", { name: /copy SWIFT/i }));
    expect(writeText).toHaveBeenCalledWith("CTBAAU2S");
  });

  it("hides the overseas block entirely when the club has not filled it in", async () => {
    getPaymentInstructions.mockResolvedValue({
      ok: true,
      details: { ...ACCOUNT, swift_bic: "", bank_address: "", account_holder_address: "" },
    });
    await renderLoaded();
    expect(screen.queryByText("Paying from overseas?")).not.toBeInTheDocument();
  });

  it("renders the club's note as markdown under the account", async () => {
    getPaymentInstructions.mockResolvedValue({
      ok: true,
      details: { ...ACCOUNT, note: "PayID:\n\n- pay@jitsu.au\n- 0400 000 000" },
    });
    await renderLoaded();
    const card = within(payCard()!);
    expect(card.getByRole("list").className).toContain("list-disc");
    expect(card.getAllByRole("listitem")).toHaveLength(2);
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

  it("points at the panel after a purchase that still owes money, not at the inbox", async () => {
    // `startMembership` reports `activated: true` for a $0 plan even when it
    // bundled an insurance invoice alongside it, so "you're all set" has to be
    // decided by what is actually still owed, not by that flag.
    listMembershipPlans.mockResolvedValue([FREE_PLAN]);
    getMyMemberships.mockResolvedValueOnce(mine([])).mockResolvedValue(mine([pendingInsurance]));
    await renderLoaded();
    expect(payCard()).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /choose & pay/i }));
    await waitFor(() => expect(payCard()).not.toBeNull());
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("payment details"));
    expect(toastSuccess).not.toHaveBeenCalledWith(expect.stringContaining("all set"));
  });

  it("says you're all set when the purchase left nothing to pay", async () => {
    listMembershipPlans.mockResolvedValue([FREE_PLAN]);
    getMyMemberships.mockResolvedValue(mine([]));
    await renderLoaded();
    await userEvent.click(screen.getByRole("button", { name: /choose & pay/i }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("all set"));
    expect(payCard()).toBeNull();
  });

  it("keeps the amount and reference when the club's details fail to load", async () => {
    // The member's own invoice is already loaded; only the club's account is
    // missing, so the panel degrades rather than disappearing.
    vi.spyOn(console, "error").mockImplementation(() => {});
    getPaymentInstructions.mockRejectedValue(new Error("nope"));
    await renderLoaded();
    const card = payCard()!;
    expect(within(card).getByText("$245")).toBeVisible();
    expect(within(card).getByText(PLAN_REF)).toBeVisible();
    expect(within(card).getByText(/could not load the club's account details/i)).toBeVisible();
    vi.restoreAllMocks();
  });

  // Different from the read failing, and it has to read differently: this is
  // the state between shipping and a manager filling the form in.
  it("says the club has not published an account yet when there is none", async () => {
    getPaymentInstructions.mockResolvedValue({ ok: true, details: null });
    await renderLoaded();
    const card = payCard()!;
    expect(within(card).getByText("$245")).toBeVisible();
    expect(within(card).getByText(PLAN_REF)).toBeVisible();
    expect(within(card).getByText(/has not published its account details yet/i)).toBeVisible();
    expect(within(card).queryByRole("button", { name: /copy BSB/i })).not.toBeInTheDocument();
  });
});

// A free trial is two classes, not a date. It cannot expire, and the person
// holding one has no membership to renew, so neither "expired" nor "lapsed"
// describes what happened to them.
describe("/membership: what a finished trial is called", () => {
  const usedUpTrial = {
    ...pendingPlan,
    id: "m9",
    plan_code: "trial_2_session",
    plan_name: "Free trial",
    kind: "trial",
    status: "expired",
    price_cents: 0,
    paid_at: "2026-07-01T00:00:00Z",
    ends_at: null,
    sessions_remaining: 0,
  };
  const endedSemester = {
    ...pendingPlan,
    id: "m10",
    status: "expired",
    paid_at: "2026-02-01T00:00:00Z",
    ends_at: "2026-06-30T00:00:00Z",
    created_at: "2026-02-01T00:00:00Z",
  };

  function lapsedWith(memberships: unknown[]) {
    getMyMemberships.mockResolvedValue({
      lifecycle: "lapsed",
      memberships,
      uts_student_number: null,
      sessions_attended: 2,
    });
  }

  it("says the trial is used up, not expired, and offers a plan instead of a renewal", async () => {
    lapsedWith([usedUpTrial]);
    await renderLoaded();
    expect(screen.getByText("Used up")).toBeVisible();
    expect(screen.queryByText("Expired")).not.toBeInTheDocument();
    expect(screen.getByText("Trial used up")).toBeVisible();
    expect(screen.getByText(/used your free trial classes/i)).toBeVisible();
    expect(screen.queryByText(/membership has lapsed/i)).not.toBeInTheDocument();
  });

  it("counts the classes left rather than dating a plan that has no end date", async () => {
    lapsedWith([usedUpTrial]);
    await renderLoaded();
    expect(screen.getByText("0 sessions left")).toBeVisible();
  });

  it("still says expired, and lapsed, for a training period that ran out of days", async () => {
    // The stored status is the same word for both. Only the plan's kind tells
    // them apart, so this is the case that would break if the label ignored it.
    lapsedWith([endedSemester]);
    await renderLoaded();
    expect(screen.getByText("Expired")).toBeVisible();
    expect(screen.queryByText("Used up")).not.toBeInTheDocument();
    expect(screen.getByText("Lapsed")).toBeVisible();
    expect(screen.getByText(/membership has lapsed/i)).toBeVisible();
  });
});
