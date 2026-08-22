import { describe, it, expect } from "vitest";
import {
  EMAIL_SETTINGS_COOKIE,
  EMAIL_SETTINGS_MAX_AGE_SECONDS,
  EMAIL_SETTINGS_PATH,
  MAX_EMAIL_SETTINGS_TOKEN_LENGTH,
  buildEmailSettingsCookie,
  clearedEmailSettingsCookie,
  readEmailSettingsToken,
} from "./email-settings-session";

/** Parse a Set-Cookie string into its value and its attributes. */
function parseSetCookie(header: string): { value: string; attrs: Set<string> } {
  const [first, ...rest] = header.split(";");
  return {
    value: first.slice(first.indexOf("=") + 1),
    attrs: new Set(rest.map((a) => a.trim())),
  };
}

describe("buildEmailSettingsCookie", () => {
  it("carries the token and expires on its own", () => {
    const header = buildEmailSettingsCookie("utsj_abc123", { secure: true });
    expect(header).not.toBeNull();
    const { value, attrs } = parseSetCookie(header!);
    expect(header!.startsWith(`${EMAIL_SETTINGS_COOKIE}=`)).toBe(true);
    expect(value).toBe("utsj_abc123");
    expect(attrs.has(`Max-Age=${EMAIL_SETTINGS_MAX_AGE_SECONDS}`)).toBe(true);
  });

  it("is unreadable from the page, and never sent on a cross-site request", () => {
    // HttpOnly: nothing on the page needs the token, so nothing may read it.
    // SameSite=Lax: this cookie authenticates a POST, and Lax is what stops a
    // page on another origin flipping somebody's switches for them. It must not
    // be Strict either, or the cookie would be withheld on the redirect that
    // follows the person's arrival from their mail client.
    const { attrs } = parseSetCookie(buildEmailSettingsCookie("t", { secure: true })!);
    expect(attrs.has("HttpOnly")).toBe(true);
    expect(attrs.has("SameSite=Lax")).toBe(true);
    expect(attrs.has("SameSite=Strict")).toBe(false);
  });

  it("scopes to the whole site, because the server functions live outside /email-settings", () => {
    const { attrs } = parseSetCookie(buildEmailSettingsCookie("t", { secure: true })!);
    expect(attrs.has("Path=/")).toBe(true);
    expect(attrs.has(`Path=${EMAIL_SETTINGS_PATH}`)).toBe(false);
  });

  it("asks for Secure on https and leaves it off on http", () => {
    // A Secure cookie is simply not stored over plain http, which would make the
    // page impossible to open on the dev server or the local e2e stack.
    expect(
      parseSetCookie(buildEmailSettingsCookie("t", { secure: true })!).attrs.has("Secure"),
    ).toBe(true);
    expect(
      parseSetCookie(buildEmailSettingsCookie("t", { secure: false })!).attrs.has("Secure"),
    ).toBe(false);
  });

  it("refuses a blank token rather than setting an empty cookie", () => {
    expect(buildEmailSettingsCookie("", { secure: true })).toBeNull();
    expect(buildEmailSettingsCookie("   ", { secure: true })).toBeNull();
  });

  it("refuses an absurdly long token", () => {
    const long = "x".repeat(MAX_EMAIL_SETTINGS_TOKEN_LENGTH + 1);
    expect(buildEmailSettingsCookie(long, { secure: true })).toBeNull();
    expect(
      buildEmailSettingsCookie("x".repeat(MAX_EMAIL_SETTINGS_TOKEN_LENGTH), { secure: true }),
    ).not.toBeNull();
  });

  it("cannot be made to write a second header", () => {
    // The token is a URL path segment, which the router hands over already
    // decoded, so `/email-settings/%0d%0aSet-Cookie:%20x=y` arrives here as a
    // string with a real CRLF in it. Encoding is what stops that becoming two
    // response headers.
    const header = buildEmailSettingsCookie("evil\r\nSet-Cookie: admin=1", { secure: true })!;
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
    expect(header.toLowerCase().split("set-cookie:").length).toBe(1);
    // And it still round-trips, so an odd token is carried rather than mangled.
    expect(readEmailSettingsToken(header.split(";")[0])).toBe("evil\r\nSet-Cookie: admin=1");
  });

  it("escapes the characters a cookie value may not contain", () => {
    const header = buildEmailSettingsCookie('a;b,c "d"', { secure: true })!;
    const { value } = parseSetCookie(header);
    for (const banned of [";", ",", '"', " "]) expect(value).not.toContain(banned);
  });
});

describe("clearedEmailSettingsCookie", () => {
  it("expires immediately, on the same path the live one used", () => {
    const header = clearedEmailSettingsCookie({ secure: true });
    const { value, attrs } = parseSetCookie(header);
    expect(value).toBe("");
    expect(attrs.has("Max-Age=0")).toBe(true);
    // A mismatched Path would leave the old cookie in place, which is the whole
    // thing this is here to prevent.
    expect(attrs.has("Path=/")).toBe(true);
    expect(attrs.has("HttpOnly")).toBe(true);
  });
});

describe("readEmailSettingsToken", () => {
  it("finds the token among other cookies", () => {
    expect(
      readEmailSettingsToken(`sb-access-token=xyz; ${EMAIL_SETTINGS_COOKIE}=utsj_abc; theme=dark`),
    ).toBe("utsj_abc");
  });

  it("round-trips what the builder wrote", () => {
    const header = buildEmailSettingsCookie("utsj_9f8e", { secure: true })!;
    expect(readEmailSettingsToken(header.split(";")[0])).toBe("utsj_9f8e");
  });

  it("has nothing to say when there is no cookie header at all", () => {
    expect(readEmailSettingsToken(undefined)).toBeNull();
    expect(readEmailSettingsToken(null)).toBeNull();
    expect(readEmailSettingsToken("")).toBeNull();
  });

  it("ignores a cookie whose name merely ends with ours", () => {
    // A prefix or suffix match would let any other cookie on the domain stand
    // in for this one.
    expect(readEmailSettingsToken(`not_${EMAIL_SETTINGS_COOKIE}=utsj_abc`)).toBeNull();
    expect(readEmailSettingsToken(`${EMAIL_SETTINGS_COOKIE}_old=utsj_abc`)).toBeNull();
  });

  it("reads a cleared cookie as no token", () => {
    expect(readEmailSettingsToken(clearedEmailSettingsCookie({ secure: true }).split(";")[0])).toBe(
      null,
    );
  });

  it("survives a malformed percent-escape instead of throwing", () => {
    // decodeURIComponent throws on this. A thrown error inside a server
    // function is a 500 on a page whose whole job is to answer uniformly.
    expect(readEmailSettingsToken(`${EMAIL_SETTINGS_COOKIE}=%E0%A4%A`)).toBeNull();
  });

  it("refuses an oversized value someone set by hand", () => {
    const long = "x".repeat(MAX_EMAIL_SETTINGS_TOKEN_LENGTH + 1);
    expect(readEmailSettingsToken(`${EMAIL_SETTINGS_COOKIE}=${long}`)).toBeNull();
  });

  it("ignores a stray segment with no equals sign", () => {
    expect(readEmailSettingsToken(`broken; ${EMAIL_SETTINGS_COOKIE}=utsj_abc`)).toBe("utsj_abc");
  });
});
