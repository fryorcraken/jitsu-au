import { describe, expect, it } from "vitest";
import {
  EMAIL_CAPS,
  FORM_LIMITS,
  describeWait,
  networkKey,
  rateLimitMessage,
  type PublicForm,
} from "./rate-limit";
import { classifySubmitFailure, isInfrastructureBody } from "./submit-resilience";

const FORMS: PublicForm[] = ["interest", "contact", "waiver", "code_of_conduct"];

describe("FORM_LIMITS", () => {
  it("leaves room for a crowd signing up on one campus network", () => {
    // UTS wifi is one address for a whole building. An O-Week stall or a first
    // class night must not hit the limit, so the forms a newcomer fills in
    // allow 50 an hour, far above the busiest real day (two).
    for (const form of ["interest", "waiver", "code_of_conduct"] as const) {
      expect(FORM_LIMITS[form].perHour).toBeGreaterThanOrEqual(50);
    }
  });

  it("never lets a day allow less than an hour does", () => {
    for (const form of FORMS) {
      expect(FORM_LIMITS[form].perDay).toBeGreaterThanOrEqual(FORM_LIMITS[form].perHour);
    }
  });
});

describe("EMAIL_CAPS", () => {
  it("lets a parent sign for three children and themselves, and register, in one day", () => {
    expect(EMAIL_CAPS.perRecipient).toBeGreaterThanOrEqual(5);
  });
});

describe("networkKey", () => {
  it("counts an IPv4 address as itself", () => {
    expect(networkKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("counts an IPv6 address by its /64, so one connection cannot rotate past the limit", () => {
    const a = networkKey("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");
    const b = networkKey("2001:db8:1234:5678::1");
    expect(a).toBe("2001:db8:1234:5678::/64");
    expect(b).toBe(a);
    expect(networkKey("2001:db8:1234:5679::1")).not.toBe(a);
  });

  it("reads compressed, padded and upper-case IPv6 the same way", () => {
    expect(networkKey("2001:0DB8:0000:0001::")).toBe("2001:db8:0:1::/64");
    expect(networkKey("::1")).toBe("0:0:0:0::/64");
    expect(networkKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("counts an IPv4 address written as IPv6 as the IPv4 address", () => {
    expect(networkKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(networkKey("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("gives no key for no address or a malformed one, so nothing is lumped together", () => {
    for (const bad of [null, undefined, "", "  ", "not-an-ip", "1:2:3", "1::2::3", "gggg::1"]) {
      expect(networkKey(bad)).toBeNull();
    }
  });
});

describe("describeWait", () => {
  it("rounds minutes up, so nobody is told to come back before they can", () => {
    expect(describeWait(1)).toBe("a minute");
    expect(describeWait(61)).toBe("about 2 minutes");
    expect(describeWait(25 * 60)).toBe("about 25 minutes");
    expect(describeWait(59 * 60 + 1)).toBe("about an hour");
  });

  it("rounds hours to the nearest, so a minute past the hour is not two hours", () => {
    expect(describeWait(60 * 60)).toBe("about an hour");
    expect(describeWait(61 * 60)).toBe("about an hour");
    expect(describeWait(90 * 60)).toBe("about 2 hours");
    expect(describeWait(19 * 3600 - 600)).toBe("about 19 hours");
  });
});

describe("rateLimitMessage", () => {
  it.each(FORMS)("tells a %s submitter what to do, as one refusal the form shows", (form) => {
    const message = rateLimitMessage(form, 25 * 60);
    expect(message).toContain("about 25 minutes");
    expect(message).toContain("Your details are still here");
    expect(message).toContain("mobile data");
    expect(message).not.toContain("—");
    // A server refusal, so useResilientSubmit shows it rather than retrying it
    // (which would only hammer the limit), and SubmitStatus prints it as is.
    expect(isInfrastructureBody(message)).toBe(false);
    expect(classifySubmitFailure(new Error(message))).toBe("server");
  });
});
