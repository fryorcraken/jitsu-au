import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { sendWaiverEmails } from "./waiver-email.server";

describe("sendWaiverEmails", () => {
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

    const result = await sendWaiverEmails({
      waiverId: "w1",
      memberName: "Ada Lovelace",
      memberGreetingName: "Addy",
      memberEmail: "ada@example.com",
      pdfUrl: "https://example.com/waiver.pdf",
      admin,
    });

    expect(result).toEqual({ sent: [], skipped: true });
    expect(from).not.toHaveBeenCalled();
  });
});
