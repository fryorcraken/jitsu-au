import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_REFERRER_POLICY,
  TOKEN_PATH_PREFIXES,
  TOKEN_PATH_REFERRER_POLICY,
  applySecurityHeaders,
  carriesTokenInPath,
  referrerPolicyFor,
} from "./security-headers";

describe("carriesTokenInPath", () => {
  it("recognises the three routes that take a token in the path", () => {
    expect(carriesTokenInPath("/api/calendar/abc123.ics")).toBe(true);
    expect(carriesTokenInPath("/api/verify-email/abc123")).toBe(true);
    expect(carriesTokenInPath("/email-settings/abc123")).toBe(true);
  });

  it("leaves every other path alone", () => {
    for (const path of [
      "/",
      "/about",
      "/waiver",
      "/notifications",
      "/api/manager/agent",
      "/api/notifications/digest",
      // Near misses: a shared prefix is not a token path.
      "/email-settings",
      "/api/calendars/nope",
    ]) {
      expect(carriesTokenInPath(path)).toBe(false);
    }
  });
});

describe("referrerPolicyFor", () => {
  it("sends nothing at all from a URL that contains a credential", () => {
    // Same-origin requests are the point: strict-origin-when-cross-origin
    // still hands the full path to same-site requests, token included.
    expect(referrerPolicyFor("/email-settings/abc123")).toBe("no-referrer");
    expect(TOKEN_PATH_REFERRER_POLICY).toBe("no-referrer");
  });

  it("sends the origin, and only the origin, off-site from every other page", () => {
    expect(referrerPolicyFor("/about")).toBe("strict-origin-when-cross-origin");
    expect(DEFAULT_REFERRER_POLICY).toBe("strict-origin-when-cross-origin");
  });
});

describe("applySecurityHeaders", () => {
  it("puts the policy on an ordinary page response", () => {
    const response = applySecurityHeaders(new Response("<html></html>"), "/about");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("keeps a token URL out of caches as well as out of referrers", async () => {
    const response = applySecurityHeaders(new Response("<html></html>"), "/email-settings/abc123");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("<html></html>");
  });

  it("leaves a route's own cache-control alone", () => {
    // The calendar feed asks for a five minute private cache on purpose: a
    // calendar client polls it. Overriding that would make every poll a miss.
    const feed = new Response("BEGIN:VCALENDAR", {
      headers: { "cache-control": "private, max-age=300" },
    });
    const response = applySecurityHeaders(feed, "/api/calendar/abc123");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("returns the very same response object when it can", () => {
    // The SSR response wraps a live stream bound to the request for cleanup.
    // Re-wrapping it would cut that binding, so mutation in place is required.
    const original = new Response("hello");
    expect(applySecurityHeaders(original, "/about")).toBe(original);
  });

  it("rebuilds a redirect, whose headers cannot be written to", () => {
    // Response.redirect() hands back an immutable headers guard.
    const redirect = Response.redirect("https://jitsu.au/account", 302);
    const response = applySecurityHeaders(redirect, "/api/verify-email/abc123");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://jitsu.au/account");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("public/_headers", () => {
  // The static file the platform reads and the middleware the app runs have to
  // agree, or a response gets one policy in one deploy path and another in the
  // other. Parse the file and hold it to the module.
  const source = readFileSync(join(process.cwd(), "public/_headers"), "utf8");

  function parseRules(text: string): Array<{ pattern: string; headers: Record<string, string> }> {
    const rules: Array<{ pattern: string; headers: Record<string, string> }> = [];
    for (const line of text.split("\n")) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      if (!/^\s/.test(line)) {
        rules.push({ pattern: line.trim(), headers: {} });
        continue;
      }
      const [name, ...rest] = line.trim().split(":");
      expect(rules.length, `header line before any path: ${line}`).toBeGreaterThan(0);
      rules[rules.length - 1].headers[name.trim().toLowerCase()] = rest.join(":").trim();
    }
    return rules;
  }

  const rules = parseRules(source);

  it("sets the site-wide policy first", () => {
    expect(rules[0]?.pattern).toBe("/*");
    expect(rules[0]?.headers["referrer-policy"]).toBe(DEFAULT_REFERRER_POLICY);
  });

  it("lists every token path, and nothing else", () => {
    expect(rules.slice(1).map((r) => r.pattern)).toEqual(
      TOKEN_PATH_PREFIXES.map((prefix) => `${prefix}*`),
    );
  });

  it("gives each rule the policy the middleware would", () => {
    for (const rule of rules) {
      const pathname = `${rule.pattern.replace(/\*$/, "")}sample-token`;
      expect(rule.headers["referrer-policy"], rule.pattern).toBe(referrerPolicyFor(pathname));
    }
  });
});
