import { describe, expect, it } from "vitest";
import { oauthReturnPath } from "./oauth-return-path";

describe("oauthReturnPath", () => {
  it("keeps the consent page's authorization id", () => {
    expect(oauthReturnPath("/.lovable/oauth/consent?authorization_id=abc")).toBe(
      "/.lovable/oauth/consent?authorization_id=abc",
    );
  });

  it("keeps an ordinary in-site path with its query and fragment", () => {
    expect(oauthReturnPath("/manager/users?q=x#top")).toBe("/manager/users?q=x#top");
  });

  it("refuses anything that would leave the site", () => {
    for (const bad of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example/",
      "/ok\u0000",
      "manager",
      42,
      undefined,
    ]) {
      expect(oauthReturnPath(bad, "/account")).toBe("/account");
    }
  });
});
