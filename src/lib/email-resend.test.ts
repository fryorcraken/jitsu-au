// The two rules a resend lives or dies by: a key the provider will not swallow,
// and a once-a-minute limit that lets a retry of the same press through.
import { describe, expect, it } from "vitest";
import {
  RESEND_COOLDOWN_SECONDS,
  formatResendMarker,
  parseResendMarker,
  resendCutoff,
  resendIdempotencyKey,
  resendMarkerKey,
  resendWaitSeconds,
} from "./email-resend";

describe("resendIdempotencyKey", () => {
  it("never reuses the original send's key, which the provider would drop", () => {
    const original = "membership-payment-m1";
    expect(resendIdempotencyKey(original, "click-1")).not.toBe(original);
    expect(resendIdempotencyKey(original, "click-1")).toBe("membership-payment-m1:resend:click-1");
  });

  it("is new for every press and the same for every retry of one press", () => {
    expect(resendIdempotencyKey("k", "click-1")).toBe(resendIdempotencyKey("k", "click-1"));
    expect(resendIdempotencyKey("k", "click-1")).not.toBe(resendIdempotencyKey("k", "click-2"));
  });
});

describe("the once-a-minute marker", () => {
  const now = new Date("2026-10-23T04:00:00.000Z");
  const secondsAgo = (s: number) => new Date(now.getTime() - s * 1000).toISOString();

  it("round-trips", () => {
    const marker = { at: now.toISOString(), resendId: "click-1" };
    expect(parseResendMarker(formatResendMarker(marker))).toEqual(marker);
    expect(parseResendMarker(null)).toBeNull();
    expect(parseResendMarker("garbage")).toBeNull();
  });

  it("is keyed per email per record", () => {
    expect(resendMarkerKey("item_invoice", "a")).not.toBe(resendMarkerKey("item_invoice", "b"));
    expect(resendMarkerKey("item_invoice", "a")).not.toBe(
      resendMarkerKey("item_invoice_receipt", "a"),
    );
  });

  it("makes a second press inside a minute wait, and says how long", () => {
    const marker = { at: secondsAgo(20), resendId: "click-1" };
    expect(resendWaitSeconds(marker, "click-2", now)).toBe(RESEND_COOLDOWN_SECONDS - 20);
  });

  it("never makes a retry of the same press wait", () => {
    const marker = { at: secondsAgo(1), resendId: "click-1" };
    expect(resendWaitSeconds(marker, "click-1", now)).toBe(0);
  });

  it("lets a new press through once the minute is up", () => {
    expect(resendWaitSeconds({ at: secondsAgo(61), resendId: "a" }, "b", now)).toBe(0);
    expect(resendWaitSeconds(null, "b", now)).toBe(0);
  });

  // The claim is a single compare in the database: "overwrite only if the
  // stored marker sorts before the cutoff". That only works if the stored
  // string sorts by time, which is why the instant comes first.
  it("stores markers that sort by time against the cutoff", () => {
    const cutoff = resendCutoff(now);
    const stale = formatResendMarker({ at: secondsAgo(90), resendId: "zzzz" });
    const fresh = formatResendMarker({ at: secondsAgo(10), resendId: "0000" });
    expect(stale < cutoff).toBe(true);
    expect(fresh < cutoff).toBe(false);
  });
});
