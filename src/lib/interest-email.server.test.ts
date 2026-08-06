import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { buildWaiverUrl, sendInterestEmails } from "./interest-email.server";

describe("buildWaiverUrl", () => {
  it("carries name, email and phone as prefill search params", () => {
    expect(
      buildWaiverUrl({ name: "Ada Lovelace", email: "ada@example.com", phone: "0400000000" }),
    ).toBe("https://jitsu.au/waiver?name=Ada+Lovelace&email=ada%40example.com&phone=0400000000");
  });

  it("omits an absent phone", () => {
    expect(buildWaiverUrl({ name: "Ada", email: "ada@example.com", phone: null })).toBe(
      "https://jitsu.au/waiver?name=Ada&email=ada%40example.com",
    );
  });

  it("falls back to the bare waiver path when nothing is provided", () => {
    expect(buildWaiverUrl({ name: "", email: "" })).toBe("https://jitsu.au/waiver");
  });

  it("carries the verification token when one was minted", () => {
    // This is what makes the EMAILED link different from the in-app one: the
    // name/email params prove nothing, an unguessable token does.
    expect(buildWaiverUrl({ name: "Ada", email: "ada@example.com", token: "utsj_abc123" })).toBe(
      "https://jitsu.au/waiver?name=Ada&email=ada%40example.com&vt=utsj_abc123",
    );
  });

  it("omits the token when minting failed, leaving a working prefill link", () => {
    expect(buildWaiverUrl({ name: "Ada", email: "ada@example.com", token: null })).toBe(
      "https://jitsu.au/waiver?name=Ada&email=ada%40example.com",
    );
  });
});

describe("sendInterestEmails", () => {
  const original = process.env.LOVABLE_API_KEY;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    if (original === undefined) delete process.env.LOVABLE_API_KEY;
    else process.env.LOVABLE_API_KEY = original;
    vi.restoreAllMocks();
  });

  it("skips sending (and never touches the admin client) when no API key is configured", async () => {
    delete process.env.LOVABLE_API_KEY;
    const from = vi.fn();
    const admin = { from } as unknown as SupabaseClient<Database>;

    const result = await sendInterestEmails({
      registrationId: "r1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "0400000000",
      message: null,
      admin,
    });

    expect(result).toEqual({ sent: [], skipped: true });
    expect(from).not.toHaveBeenCalled();
  });
});
