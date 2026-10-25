import { describe, expect, it } from "vitest";
import { describeRedirectTarget } from "./oauth-consent";

describe("describeRedirectTarget", () => {
  it("names a website by its host, port included", () => {
    expect(describeRedirectTarget("https://claude.ai/api/mcp/auth_callback")).toEqual({
      kind: "website",
      host: "claude.ai",
    });
    expect(describeRedirectTarget("https://evil.example:8443/cb")).toEqual({
      kind: "website",
      host: "evil.example:8443",
    });
  });

  it("does not let a lookalike pass as this computer", () => {
    expect(describeRedirectTarget("https://localhost.evil.example/cb")).toEqual({
      kind: "website",
      host: "localhost.evil.example",
    });
    expect(describeRedirectTarget("https://127.0.0.1.evil.example/cb")).toEqual({
      kind: "website",
      host: "127.0.0.1.evil.example",
    });
  });

  it("treats loopback addresses as a program on this computer", () => {
    for (const uri of [
      "http://localhost:53682/callback",
      "http://127.0.0.1:33418/",
      "http://[::1]:8080/cb",
      "http://app.localhost/cb",
      "http://localhost.:8080/cb",
      "http://[::ffff:127.0.0.1]:3000/cb",
    ]) {
      expect(describeRedirectTarget(uri)).toEqual({ kind: "this-computer" });
    }
  });

  it("names an installed app by its scheme", () => {
    expect(describeRedirectTarget("cursor://anysphere.cursor-mcp/oauth/callback")).toEqual({
      kind: "app",
      scheme: "cursor",
    });
  });

  it("refuses to describe anything it cannot vouch for", () => {
    for (const uri of [
      "",
      "not a url",
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      undefined,
      42,
    ]) {
      expect(describeRedirectTarget(uri)).toEqual({ kind: "unknown" });
    }
  });
});
