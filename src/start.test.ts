// The registration that makes the security headers real.
//
// `security-headers.test.ts` proves the module decides the right header for a
// path, and `server.test.ts` proves the SSR entry's two hand-built error pages
// carry it. Neither covers the thing that puts the header on an ordinary 200,
// which is `securityHeadersMiddleware` sitting in `requestMiddleware` here: it
// is the only place a normal page or server-function response gets one.
//
// Delete that entry and both of those suites stay green, e2e stays green (no
// spec reads a response header), and every page on the live site quietly stops
// sending Referrer-Policy. So this reads the source and holds the wiring in
// place, the same way seo.test.ts holds the route files to the sitemap.
//
// Asserted against the source rather than by driving the instance because
// `createStart` hands back a configured object whose middleware array is not
// reachable to read, and a test that cannot see the list cannot notice one
// going missing from it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/start.ts"), "utf8");

function requestMiddlewareNames(): string[] {
  const match = source.match(/requestMiddleware:\s*\[([^\]]*)\]/);
  expect(match, "requestMiddleware array not found in src/start.ts").toBeTruthy();
  return match![1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

describe("startInstance request middleware", () => {
  it("registers the security headers middleware", () => {
    expect(requestMiddlewareNames()).toContain("securityHeadersMiddleware");
  });

  it("puts it outermost, so the 500 page gets the headers too", () => {
    // `errorMiddleware` builds its own Response for an unhandled throw. Ordered
    // the other way, that page would leave without a Referrer-Policy, and an
    // error page is reachable from a token URL like any other.
    const names = requestMiddlewareNames();
    expect(names[0]).toBe("securityHeadersMiddleware");
    expect(names).toContain("errorMiddleware");
    expect(names.indexOf("securityHeadersMiddleware")).toBeLessThan(
      names.indexOf("errorMiddleware"),
    );
  });

  it("builds that middleware out of the shared module, not its own copy", () => {
    // A second spelling of the rule here would drift from the one the tests and
    // public/_headers are held to.
    expect(source).toContain('from "./lib/security-headers"');
    expect(source).toContain("applySecurityHeaders(result.response, pathname)");
  });
});
