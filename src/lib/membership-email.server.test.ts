import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const sendLovableEmail = vi.fn();
vi.mock("@lovable.dev/email-js", () => ({
  sendLovableEmail: (...args: unknown[]) => sendLovableEmail(...args),
}));
vi.mock("@/lib/waiver-email.server", () => ({ getManagerEmails: () => Promise.resolve([]) }));
vi.mock("@/lib/club-settings.server", () => ({
  readClubPaymentDetails: () => Promise.resolve({ ok: true, details: null }),
}));

const { sendMembershipPaidEmail, sendMembershipPaymentEmail } =
  await import("./membership-email.server");

describe("membership emails without an API key", () => {
  const original = process.env.LOVABLE_API_KEY;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    if (original === undefined) delete process.env.LOVABLE_API_KEY;
    else process.env.LOVABLE_API_KEY = original;
    vi.restoreAllMocks();
  });

  it("payment email skips (and never touches the admin client) when no API key", async () => {
    delete process.env.LOVABLE_API_KEY;
    const from = vi.fn();
    const admin = { from } as unknown as SupabaseClient<Database>;

    const result = await sendMembershipPaymentEmail({
      membershipId: "m1",
      memberName: "Ada Lovelace",
      memberGreetingName: "Addy",
      memberEmail: "ada@example.com",
      planName: "One semester",
      amount: "$245",
      reference: "UTSJ-ABC234",
      admin,
    });

    expect(result).toEqual({ sent: [], skipped: true });
    expect(from).not.toHaveBeenCalled();
  });

  it("payment-received email skips when no API key", async () => {
    delete process.env.LOVABLE_API_KEY;
    const result = await sendMembershipPaidEmail({
      membershipId: "m1",
      memberGreetingName: "Addy",
      memberEmail: "ada@example.com",
      planName: "One semester",
      validity: "Valid for 182 days.",
      amount: "$245",
    });
    expect(result).toEqual({ sent: false, skipped: true });
  });
});

// An invoice for a child goes to their parent's inbox, so the subject line is
// the only thing in the mail client's list that says which of their children
// it is about. A parent with three of them gets three identical "your
// membership" lines otherwise, and no way to tell which one is still unpaid.
describe("who the subject line is about", () => {
  const original = process.env.LOVABLE_API_KEY;

  beforeEach(() => {
    process.env.LOVABLE_API_KEY = "test-key";
    sendLovableEmail.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    if (original === undefined) delete process.env.LOVABLE_API_KEY;
    else process.env.LOVABLE_API_KEY = original;
    vi.restoreAllMocks();
  });

  /** The subject of the nth email sent. */
  const subjectOf = (n = 0) => (sendLovableEmail.mock.calls[n][0] as { subject: string }).subject;

  const admin = { from: vi.fn() } as unknown as SupabaseClient<Database>;

  it("names the child on an invoice raised for one", async () => {
    await sendMembershipPaymentEmail({
      membershipId: "m1",
      memberName: "Bea Lovelace",
      memberGreetingName: "Ada",
      memberEmail: "ada@example.com",
      forName: "Bea",
      planName: "One semester",
      amount: "$245",
      reference: "UTSJ-ABC234",
      admin,
    });

    expect(subjectOf()).toBe("Pay $245 to activate Bea's One semester");
  });

  it("still says 'your' when the member is the reader", async () => {
    await sendMembershipPaymentEmail({
      membershipId: "m1",
      memberName: "Ada Lovelace",
      memberGreetingName: "Ada",
      memberEmail: "ada@example.com",
      planName: "One semester",
      amount: "$245",
      reference: "UTSJ-ABC234",
      admin,
    });

    expect(subjectOf()).toBe("Pay $245 to activate your One semester");
  });

  it("names the child on the receipt too", async () => {
    await sendMembershipPaidEmail({
      membershipId: "m1",
      memberGreetingName: "Ada",
      memberEmail: "ada@example.com",
      forName: "Bea",
      planName: "One semester",
      validity: "Valid for 182 days.",
      amount: "$245",
    });

    expect(subjectOf()).toBe("Payment received for Bea's One semester");
  });

  it("captions the address on the manager's copy", async () => {
    // The manager copy names the CHILD and carries the PARENT's address. Bare,
    // that is a mailbox a manager writes to and nobody reads.
    const managers = await import("@/lib/waiver-email.server");
    vi.spyOn(managers, "getManagerEmails").mockResolvedValue(["manager@example.com"]);

    await sendMembershipPaymentEmail({
      membershipId: "m1",
      memberName: "Bea Lovelace",
      memberGreetingName: "Ada",
      memberEmail: "ada@example.com",
      forName: "Bea",
      planName: "One semester",
      amount: "$245",
      reference: "UTSJ-ABC234",
      admin,
    });

    const managerCopy = sendLovableEmail.mock.calls.find(
      (c) => (c[0] as { to: string }).to === "manager@example.com",
    );
    expect(managerCopy).toBeDefined();
    expect((managerCopy![0] as { html: string }).html).toContain("Ada&#x27;s address");
  });
});
