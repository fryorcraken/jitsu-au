import { describe, expect, it } from "vitest";

import {
  SITE_GATE_COOKIE,
  SITE_GATE_MAX_AGE,
  SITE_GATE_PATH,
  buildGateCookie,
  gateStamp,
  isGateExempt,
  readCookie,
  renderGatePage,
  safeRedirectPath,
} from "./site-gate";

describe("isGateExempt", () => {
  it("lets machine callers with their own auth through", () => {
    expect(isGateExempt("/api/manager/agent")).toBe(true);
    expect(isGateExempt("/lovable/email/auth/webhook")).toBe(true);
  });

  it("gates every normal page", () => {
    for (const path of ["/", "/classes", "/waiver", "/auth", "/manager/waivers", "/apidocs"]) {
      expect(isGateExempt(path)).toBe(false);
    }
  });
});

describe("gateStamp", () => {
  it("is stable for the same password", () => {
    expect(gateStamp("open sesame")).toBe(gateStamp("open sesame"));
  });

  it("differs between passwords", () => {
    expect(gateStamp("open sesame")).not.toBe(gateStamp("open sesamf"));
  });

  it("does not contain the password", () => {
    expect(gateStamp("hunter2")).not.toContain("hunter2");
  });
});

describe("readCookie", () => {
  it("finds the named cookie among others", () => {
    expect(readCookie(`a=1; ${SITE_GATE_COOKIE}=abc; b=2`, SITE_GATE_COOKIE)).toBe("abc");
  });

  it("decodes the value", () => {
    expect(readCookie(`${SITE_GATE_COOKIE}=a%20b`, SITE_GATE_COOKIE)).toBe("a b");
  });

  it("does not match a cookie whose name merely ends with the target", () => {
    expect(readCookie(`not_${SITE_GATE_COOKIE}=abc`, SITE_GATE_COOKIE)).toBeNull();
  });

  it("returns null with no header or no match", () => {
    expect(readCookie(null, SITE_GATE_COOKIE)).toBeNull();
    expect(readCookie("", SITE_GATE_COOKIE)).toBeNull();
    expect(readCookie("other=1", SITE_GATE_COOKIE)).toBeNull();
  });
});

describe("buildGateCookie", () => {
  it("sets a site-wide, http-only cookie", () => {
    const cookie = buildGateCookie("abc", false);
    expect(cookie).toContain(`${SITE_GATE_COOKIE}=abc`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Max-Age=${SITE_GATE_MAX_AGE}`);
    expect(cookie).not.toContain("Secure");
  });

  it("adds Secure over https", () => {
    expect(buildGateCookie("abc", true)).toContain("Secure");
  });
});

describe("safeRedirectPath", () => {
  it("keeps same-site paths", () => {
    expect(safeRedirectPath("/classes?a=1")).toBe("/classes?a=1");
  });

  it("keeps the fragment auth links carry their token in", () => {
    expect(safeRedirectPath("/auth#access_token=abc&type=magiclink")).toBe(
      "/auth#access_token=abc&type=magiclink",
    );
  });

  it("rejects anything that could leave the site", () => {
    expect(safeRedirectPath("//evil.example")).toBe("/");
    expect(safeRedirectPath("/\\evil.example")).toBe("/");
    expect(safeRedirectPath("https://evil.example")).toBe("/");
    expect(safeRedirectPath("classes")).toBe("/");
    expect(safeRedirectPath(null)).toBe("/");
    expect(safeRedirectPath(undefined)).toBe("/");
  });
});

describe("renderGatePage", () => {
  it("posts the password back to the gate path with the redirect", () => {
    const html = renderGatePage({ redirectTo: "/classes" });
    expect(html).toContain(`action="${SITE_GATE_PATH}"`);
    expect(html).toContain('name="password"');
    expect(html).toContain('value="/classes"');
    expect(html).toContain('content="noindex, nofollow"');
  });

  it("carries the URL fragment into the redirect, so auth links survive", () => {
    const html = renderGatePage({ redirectTo: "/auth" });
    expect(html).toContain("location.hash");
    expect(html).toContain(`document.querySelector('input[name="redirect"]')`);
  });

  it("shows an error only after a wrong password", () => {
    expect(renderGatePage({ redirectTo: "/" })).not.toContain("isn't right");
    expect(renderGatePage({ redirectTo: "/", failed: true })).toContain("isn't right");
  });

  it("escapes the redirect value and drops off-site ones", () => {
    const html = renderGatePage({ redirectTo: '/x"><script>alert(1)</script>' });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(renderGatePage({ redirectTo: "https://evil.example" })).toContain('value="/"');
  });
});
