import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  sendMembershipActivatedEmail,
  sendMembershipPaymentEmail,
} from "./membership-email.server";

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

  it("activation email skips when no API key", async () => {
    delete process.env.LOVABLE_API_KEY;
    const result = await sendMembershipActivatedEmail({
      membershipId: "m1",
      memberGreetingName: "Addy",
      memberEmail: "ada@example.com",
      planName: "One semester",
      validity: "Valid for 182 days.",
    });
    expect(result).toEqual({ sent: false, skipped: true });
  });
});
