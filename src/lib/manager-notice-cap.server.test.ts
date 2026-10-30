// The daily cap on managers' per-submission emails (#52): under it they go
// out as before, the one that reaches it is replaced by a single "paused"
// note, and after that nothing until the day quietens down.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { mayNotifyManagers } from "./manager-notice-cap.server";

const { sendLovableEmail, claimManagerNotice } = vi.hoisted(() => ({
  sendLovableEmail: vi.fn(),
  claimManagerNotice: vi.fn(),
}));
vi.mock("@lovable.dev/email-js", () => ({ sendLovableEmail }));
vi.mock("@/lib/rate-limit.server", () => ({ claimManagerNotice }));

const admin = {} as SupabaseClient<Database>;
const opts = {
  kind: "waiver" as const,
  submissionKey: "w21",
  recipients: ["manager-a@example.com", "manager-b@example.com"],
  screenUrl: "https://utsjitsu.com.au/manager/waivers",
  apiKey: "test-key",
};

beforeEach(() => {
  vi.clearAllMocks();
  sendLovableEmail.mockResolvedValue({ success: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("mayNotifyManagers", () => {
  it("says go ahead under the cap, and sends nothing itself", async () => {
    claimManagerNotice.mockResolvedValue("send");
    await expect(mayNotifyManagers(admin, opts)).resolves.toBe(true);
    expect(claimManagerNotice).toHaveBeenCalledWith(admin, "waiver", "w21");
    expect(sendLovableEmail).not.toHaveBeenCalled();
  });

  it("replaces the copy that reaches the cap with one note to each manager", async () => {
    claimManagerNotice.mockResolvedValue("pause");
    await expect(mayNotifyManagers(admin, opts)).resolves.toBe(false);

    const payloads = sendLovableEmail.mock.calls.map(([p]) => p);
    expect(payloads.map((p) => p.to)).toEqual(opts.recipients);
    for (const p of payloads) {
      expect(p.subject).toBe("Lots of waivers signed today, so we've paused those emails");
      expect(p.html).toContain("https://utsjitsu.com.au/manager/waivers");
      expect(p.text).toContain("More than 20 waivers have been signed");
      // Approving a bot's waiver opens an account and emails a stranger.
      expect(p.text).toMatch(/Don.t approve anyone you don.t recognise/);
      expect(p.html).not.toContain("—");
    }
    expect(new Set(payloads.map((p) => p.idempotency_key)).size).toBe(2);
  });

  it("sends nothing at all once paused", async () => {
    claimManagerNotice.mockResolvedValue("paused");
    await expect(mayNotifyManagers(admin, opts)).resolves.toBe(false);
    expect(sendLovableEmail).not.toHaveBeenCalled();
  });

  it("spends nothing from the cap when there is no manager to tell", async () => {
    await expect(mayNotifyManagers(admin, { ...opts, recipients: [] })).resolves.toBe(false);
    expect(claimManagerNotice).not.toHaveBeenCalled();
  });
});
