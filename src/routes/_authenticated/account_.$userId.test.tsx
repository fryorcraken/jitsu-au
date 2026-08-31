// The per-child page. Two things are worth pinning, and neither is how it
// looks.
//
// The REFUSAL is the important one. Every gate is on the server, so this page
// is not a security boundary. What it has to get right is that reaching
// somebody else's child looks exactly like reaching a uuid that is nobody:
// two different screens would turn the address bar into a way to ask the club
// who exists.
//
// The VOICE is the other. #110 recorded that every string in these cards was
// second person, which is right on `/account` and wrong under a child's name.
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const getMyProfile = vi.fn();
const listMyHousehold = vi.fn();

const CHILD = {
  user_id: "child-1",
  first_name: "Bea",
  middle_name: null,
  last_name: "Lovelace",
  preferred_name: null,
  display_name: null,
  date_of_birth: "2015-04-02",
  address: "1 Broadway, Ultimo NSW",
  phone: "0400 000 002",
  uts_student_number: null,
  emergency_contact_name: "Ada Lovelace",
  emergency_contact_relationship: "Parent",
  emergency_contact_phone: "0400 000 001",
  medical_notes: null,
  is_minor: true,
  guardian_name: "Ada Lovelace",
  guardian_relationship: "Parent",
  sms_whatsapp_consent: false,
  media_consent: null,
  gi_size: null,
  belt_size: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const HOUSEHOLD = [
  {
    user_id: "parent-1",
    name: "Ada Lovelace",
    is_self: true,
    lifecycle_status: "member",
    has_any_waiver: true,
    latest_plan_name: "One semester",
    latest_plan_kind: "period",
    latest_membership_status: "active",
    latest_sessions_remaining: null,
  },
  {
    user_id: "child-1",
    name: "Bea Lovelace",
    is_self: false,
    lifecycle_status: "visitor",
    has_any_waiver: true,
    latest_plan_name: "Free trial",
    latest_plan_kind: "trial",
    latest_membership_status: "active",
    latest_sessions_remaining: 2,
  },
];

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useParams: () => ({ userId: "child-1" }),
  }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));

vi.mock("@/lib/waiver.functions", () => ({
  getMyProfile: (...args: unknown[]) => getMyProfile(...args),
  listMyWaivers: vi.fn().mockResolvedValue([]),
  getWaiverPdfUrl: vi.fn(),
}));

vi.mock("@/lib/household.functions", () => ({
  listMyHousehold: (...args: unknown[]) => listMyHousehold(...args),
  listHouseholdInvoices: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/profile.functions", () => ({ updateMyProfile: vi.fn() }));

vi.mock("@/lib/code-of-conduct.functions", () => ({
  getCodeOfConductSigner: vi.fn().mockResolvedValue({ status: null }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "parent-1" }, session: null, loading: false }),
}));

const { Route } = await import("./account_.$userId");
const PersonPage = (Route as unknown as { component: () => ReactNode }).component;

beforeEach(() => {
  vi.clearAllMocks();
  getMyProfile.mockResolvedValue(CHILD);
  listMyHousehold.mockResolvedValue(HOUSEHOLD);
});

describe("a parent looking at their child", () => {
  it("asks the server about the child, not about themselves", async () => {
    render(<PersonPage />);
    await waitFor(() => expect(getMyProfile).toHaveBeenCalled());
    // The whole page is "somebody else's record". A call that forgot the target
    // would render the PARENT's details under the child's name, which is the
    // silent wrong-person read #102 exists to end.
    expect(getMyProfile).toHaveBeenCalledWith({ data: { userId: "child-1" } });
  });

  it("speaks about the child by name, never as 'you'", async () => {
    render(<PersonPage />);
    await screen.findByRole("heading", { name: /Bea Lovelace/ });
    expect(await screen.findByText("About Bea")).toBeInTheDocument();
    expect(screen.getByText(/Bea's details/i)).toBeInTheDocument();
    expect(screen.getByText(/Bea's records/i)).toBeInTheDocument();
    // The one that mattered most: a consent question about a child, phrased at
    // the parent reading it.
    expect(screen.getByText(/photos or video of Bea/i)).toBeInTheDocument();
  });
});

describe("somebody reaching for a person who is not theirs", () => {
  /** The gate's own sentence, which is the only thing it ever says. */
  const NOT_YOURS = "You can only see or change your own account and the people on it.";

  it("refuses, and says nothing about whether the person exists", async () => {
    getMyProfile.mockRejectedValue(new Error(NOT_YOURS));
    render(<PersonPage />);

    expect(await screen.findByText(/can't show you this page/i)).toBeInTheDocument();
    expect(screen.getByText(/only see or change your own account/i)).toBeInTheDocument();
    // The words that would turn this page into a way to enumerate people.
    expect(screen.queryByText(/no such person/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
  });

  it("shows a dropped connection as a retry, not as a refusal", async () => {
    // The two must not collapse into one screen. Told "this is not yours" after
    // a timeout, a parent would believe the club had lost their child.
    getMyProfile.mockRejectedValue(new Error("Failed to fetch"));
    render(<PersonPage />);

    expect(await screen.findByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText(/can't show you this page/i)).not.toBeInTheDocument();
  });
});
