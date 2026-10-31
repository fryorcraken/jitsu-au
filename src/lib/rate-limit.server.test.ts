// The counter calls behind the public forms' limits and the email caps (#52).
//
// What the counter itself does (counting, the retry rule, the wait) is SQL and
// is checked against a real database by supabase/lint/rate-limit-claims.sql.
// This file pins what the app asks it, and what the app does with the answer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  claimManagerNotice,
  claimRateLimit,
  claimVisitorEmail,
  enforcePublicFormLimit,
  releaseVisitorEmail,
} from "./rate-limit.server";
import { EMAIL_CAPS, FORM_LIMITS } from "./rate-limit";

type Reply = { allowed: boolean; retry_after_seconds: number };

/** An admin client whose `rpc` answers each claim in turn from `replies`. */
function fakeAdmin(...replies: Array<Reply | Error>) {
  const rpc = vi.fn(async (fn: string, _args: Record<string, unknown>) => {
    // A release answers nothing and takes no reply off the queue.
    if (fn === "release_rate_limit") return { data: null, error: null };
    const next = replies.shift() ?? { allowed: true, retry_after_seconds: 0 };
    if (next instanceof Error) return { data: null, error: { message: next.message } };
    return { data: [next], error: null };
  });
  return { admin: { rpc } as unknown as SupabaseClient<Database>, rpc };
}

const ok: Reply = { allowed: true, retry_after_seconds: 0 };
const no = (seconds: number): Reply => ({ allowed: false, retry_after_seconds: seconds });

const fromCloudflare = (ip: string) => (name: string) =>
  name === "cf-connecting-ip" ? ip : undefined;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("claimRateLimit", () => {
  it("passes the counter, the limits and the dedupe key, and reads the answer", async () => {
    const { admin, rpc } = fakeAdmin(no(90));
    await expect(
      claimRateLimit(admin, {
        bucket: "form:interest",
        subject: "203.0.113.7",
        dedupeKey: "sub-1",
        perHour: 50,
        perDay: 150,
      }),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 90 });
    expect(rpc).toHaveBeenCalledWith("claim_rate_limit", {
      _bucket: "form:interest",
      _subject: "203.0.113.7",
      _dedupe_key: "sub-1",
      _hour_max: 50,
      _day_max: 150,
    });
  });

  it("leaves out what was not given, so the database's defaults (no limit) apply", async () => {
    const { admin, rpc } = fakeAdmin(ok);
    await claimRateLimit(admin, { bucket: "b", subject: "s", dedupeKey: null, perDay: 6 });
    expect(rpc.mock.calls[0][1]).toEqual({
      _bucket: "b",
      _subject: "s",
      _dedupe_key: undefined,
      _hour_max: undefined,
      _day_max: 6,
    });
  });

  it("lets everything through when the counter cannot be reached", async () => {
    // A refusal here would turn a database hiccup into a lost waiver.
    const failing = fakeAdmin(new Error("connection refused")).admin;
    await expect(claimRateLimit(failing, { bucket: "b", subject: "s" })).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    const throwing = {
      rpc: () => Promise.reject(new TypeError("fetch failed")),
    } as unknown as SupabaseClient<Database>;
    await expect(claimRateLimit(throwing, { bucket: "b", subject: "s" })).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    const empty = {
      rpc: async () => ({ data: [], error: null }),
    } as unknown as SupabaseClient<Database>;
    await expect(claimRateLimit(empty, { bucket: "b", subject: "s" })).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });
});

describe("enforcePublicFormLimit", () => {
  it("counts the form per network, with the submission id as the retry key", async () => {
    // The submission id is what makes useResilientSubmit's automatic retries
    // of one form fill free: the counter lets the same key through without
    // counting it again (proved in SQL by rate-limit-claims.sql).
    const { admin, rpc } = fakeAdmin(ok);
    await enforcePublicFormLimit(admin, fromCloudflare("203.0.113.7"), "waiver", "sub-1");
    expect(rpc).toHaveBeenCalledWith("claim_rate_limit", {
      _bucket: "form:waiver",
      _subject: "203.0.113.7",
      _dedupe_key: "sub-1",
      _hour_max: FORM_LIMITS.waiver.perHour,
      _day_max: FORM_LIMITS.waiver.perDay,
    });
  });

  it("refuses with the message the person sees, saying how long to wait", async () => {
    const { admin } = fakeAdmin(no(25 * 60));
    await expect(
      enforcePublicFormLimit(admin, fromCloudflare("203.0.113.7"), "interest", "sub-2"),
    ).rejects.toThrow(/sign-ups.*about 25 minutes.*mobile data/);
  });

  it("does not limit a request whose address it cannot tell", async () => {
    const { admin, rpc } = fakeAdmin(no(60));
    await expect(
      enforcePublicFormLimit(admin, () => undefined, "contact", "sub-3"),
    ).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("counts by the address Cloudflare vouches for, not one the caller wrote", async () => {
    const { admin, rpc } = fakeAdmin(ok);
    const headers: Record<string, string> = {
      "x-forwarded-for": "198.51.100.66, 203.0.113.7",
      "cf-connecting-ip": "203.0.113.7",
    };
    await enforcePublicFormLimit(admin, (n) => headers[n], "interest", null);
    expect(rpc.mock.calls[0][1]._subject).toBe("203.0.113.7");
  });
});

describe("claimVisitorEmail", () => {
  const claims = (rpc: ReturnType<typeof fakeAdmin>["rpc"]) =>
    rpc.mock.calls.filter(([fn]) => fn === "claim_rate_limit").map(([, args]) => args);
  const releases = (rpc: ReturnType<typeof fakeAdmin>["rpc"]) =>
    rpc.mock.calls.filter(([fn]) => fn === "release_rate_limit").map(([, args]) => args);

  it("checks the address, then the network and the club, each keyed on the email", async () => {
    const { admin, rpc } = fakeAdmin(ok, ok, ok);
    await expect(
      claimVisitorEmail(admin, " Ada@Example.com ", "interest-applicant-r1", "203.0.113.7"),
    ).resolves.toBe(true);
    const [perAddress, perNetwork, total] = claims(rpc);
    expect(perAddress).toMatchObject({
      _bucket: "email:recipient",
      _dedupe_key: "interest-applicant-r1",
      _day_max: EMAIL_CAPS.perRecipient,
    });
    // The counter never holds the address in the clear, and case or spacing
    // does not make it a different address.
    expect(perAddress._subject).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rpc.mock.calls)).not.toMatch(/ada@example\.com/i);
    expect(perNetwork).toMatchObject({
      _bucket: "email:visitor-network",
      _subject: "203.0.113.7",
      _dedupe_key: "interest-applicant-r1",
      _day_max: EMAIL_CAPS.perNetwork,
    });
    expect(total).toMatchObject({
      _bucket: "email:visitor-total",
      _subject: "club",
      _dedupe_key: "interest-applicant-r1",
      _day_max: EMAIL_CAPS.visitorTotal,
    });
    expect(releases(rpc)).toEqual([]);

    const again = fakeAdmin(ok, ok, ok);
    await claimVisitorEmail(again.admin, "ada@example.com", "contact-sender-m1", "203.0.113.7");
    expect(claims(again.rpc)[0]._subject).toBe(perAddress._subject);
  });

  it("holds the email back once that address has had its emails today, spending nothing else", async () => {
    const { admin, rpc } = fakeAdmin(no(3600));
    await expect(claimVisitorEmail(admin, "ada@example.com", "k", "203.0.113.7")).resolves.toBe(
      false,
    );
    expect(claims(rpc)).toHaveLength(1);
  });

  it("holds the email back once that network has had its share, and gives the rest back", async () => {
    // Before this, one network inside its own form limits could spend the
    // whole club-wide allowance and leave every real visitor without a
    // confirmation for a day.
    const { admin, rpc } = fakeAdmin(ok, no(3600), ok);
    await expect(claimVisitorEmail(admin, "ada@example.com", "k", "203.0.113.7")).resolves.toBe(
      false,
    );
    expect(
      releases(rpc)
        .map((a) => a._bucket)
        .sort(),
    ).toEqual(["email:recipient", "email:visitor-network", "email:visitor-total"]);
    for (const r of releases(rpc)) expect(r._dedupe_key).toBe("k");
  });

  it("holds the email back once the club has sent its day's worth, and gives the address its slot back", async () => {
    // Before this, a refusal here still spent one of the address's six, so a
    // parent signing for their children during a flood could use up a day's
    // allowance without receiving a single email.
    const { admin, rpc } = fakeAdmin(ok, ok, no(3600));
    await expect(claimVisitorEmail(admin, "ada@example.com", "k", "203.0.113.7")).resolves.toBe(
      false,
    );
    expect(releases(rpc).map((a) => a._bucket)).toContain("email:recipient");
  });

  it("counts no network when the request has no usable address", async () => {
    const { admin, rpc } = fakeAdmin(ok, ok);
    await expect(claimVisitorEmail(admin, "ada@example.com", "k", null)).resolves.toBe(true);
    expect(claims(rpc).map((a) => a._bucket)).toEqual(["email:recipient", "email:visitor-total"]);
  });
});

describe("releaseVisitorEmail", () => {
  it("gives back every slot the email could have claimed, and survives a failure", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } })
      .mockResolvedValue({ data: null, error: null });
    await releaseVisitorEmail({ rpc } as unknown as SupabaseClient<Database>, "k");
    expect(rpc.mock.calls.map(([fn, args]) => [fn, args._bucket, args._dedupe_key])).toEqual([
      ["release_rate_limit", "email:recipient", "k"],
      ["release_rate_limit", "email:visitor-network", "k"],
      ["release_rate_limit", "email:visitor-total", "k"],
    ]);
  });
});

describe("claimManagerNotice", () => {
  it("sends while the day's count is under the cap", async () => {
    const { admin, rpc } = fakeAdmin(ok);
    await expect(claimManagerNotice(admin, "lead", "r1")).resolves.toBe("send");
    expect(rpc.mock.calls[0][1]).toMatchObject({
      _bucket: "email:manager:lead",
      _subject: "club",
      _dedupe_key: "r1",
      _day_max: EMAIL_CAPS.managerPerKind,
    });
  });

  it("pauses once at the cap, then stays paused", async () => {
    const first = fakeAdmin(no(60), ok);
    await expect(claimManagerNotice(first.admin, "message", "m21")).resolves.toBe("pause");
    expect(first.rpc.mock.calls[1][1]).toMatchObject({
      _bucket: "email:manager-paused:message",
      _day_max: 1,
    });

    const later = fakeAdmin(no(60), no(60));
    await expect(claimManagerNotice(later.admin, "message", "m22")).resolves.toBe("paused");
  });
});
