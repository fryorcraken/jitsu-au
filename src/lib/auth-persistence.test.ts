import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above this file's other statements, so the spy it closes
// over has to be hoisted with it.
const { signOut } = vi.hoisted(() => ({ signOut: vi.fn(() => Promise.resolve({ error: null })) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { signOut } } }));

import {
  applyRememberPreference,
  isAuthCallbackUrl,
  REMEMBER_STORAGE_KEY,
  SESSION_ACTIVE_KEY,
  shouldForgetSession,
} from "./auth-persistence";

describe("shouldForgetSession", () => {
  it("forgets the session when the user opted out and the browser restarted", () => {
    // remember = "false" (opted out) + no session marker (browser session ended)
    expect(shouldForgetSession("false", null)).toBe(true);
  });

  it("keeps the session within the same browser session even when opted out", () => {
    expect(shouldForgetSession("false", "1")).toBe(false);
  });

  it("keeps the session when the user asked to be remembered", () => {
    expect(shouldForgetSession("true", null)).toBe(false);
    expect(shouldForgetSession("true", "1")).toBe(false);
  });

  it("keeps the session when no preference was ever recorded (default / existing users)", () => {
    expect(shouldForgetSession(null, null)).toBe(false);
    expect(shouldForgetSession(null, "1")).toBe(false);
  });
});

describe("isAuthCallbackUrl", () => {
  it("recognises the magic-link landing URL", () => {
    // An email sign-in link lands here, tokens in the fragment. This is the
    // case that used to be mistaken for a restarted browser and signed out.
    expect(
      isAuthCallbackUrl(
        "https://jitsu.au/account#access_token=eyJhbGc.eyJzdWI.sig&expires_in=3600&refresh_token=abc&token_type=bearer&type=magiclink",
      ),
    ).toBe(true);
  });

  it("recognises a failed email link", () => {
    expect(
      isAuthCallbackUrl(
        "https://jitsu.au/account#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid",
      ),
    ).toBe(true);
  });

  it("recognises the PKCE and verify-token query forms", () => {
    expect(isAuthCallbackUrl("https://jitsu.au/account?code=pkce-code")).toBe(true);
    expect(isAuthCallbackUrl("https://jitsu.au/account?token_hash=abc&type=magiclink")).toBe(true);
  });

  it("does not treat an ordinary page load as a callback", () => {
    expect(isAuthCallbackUrl("https://jitsu.au/account")).toBe(false);
    // Supabase leaves the bare "#" behind after it consumes the tokens, so a
    // reload of the landing URL must not count as a callback any more.
    expect(isAuthCallbackUrl("https://jitsu.au/account#")).toBe(false);
    expect(isAuthCallbackUrl("https://jitsu.au/auth?redirect=%2Faccount")).toBe(false);
    expect(isAuthCallbackUrl("https://jitsu.au/classes#schedule")).toBe(false);
  });

  it("is safe on a non-URL string", () => {
    expect(isAuthCallbackUrl("")).toBe(false);
    expect(isAuthCallbackUrl("/account")).toBe(false);
  });
});

describe("applyRememberPreference", () => {
  const MAGIC_LINK_LANDING =
    "https://jitsu.au/account#access_token=eyJhbGc.eyJzdWI.sig&refresh_token=abc&type=magiclink";

  beforeEach(() => {
    signOut.mockClear();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("keeps a session that an email link just created in a fresh tab", () => {
    // The regression this guards: an email link opens a new tab, so the browser
    // session marker is absent, which used to look exactly like a restarted
    // browser. Anyone who had opted out of "Keep me signed in" was signed
    // straight back out by the link that had just signed them in.
    localStorage.setItem(REMEMBER_STORAGE_KEY, "false");

    applyRememberPreference(MAGIC_LINK_LANDING);

    expect(signOut).not.toHaveBeenCalled();
    // The durable opt-out survives, so the next browser restart still forgets.
    expect(localStorage.getItem(REMEMBER_STORAGE_KEY)).toBe("false");
    expect(sessionStorage.getItem(SESSION_ACTIVE_KEY)).toBe("1");
  });

  it("still forgets an opted-out session on an ordinary load after a restart", () => {
    localStorage.setItem(REMEMBER_STORAGE_KEY, "false");

    applyRememberPreference("https://jitsu.au/account");

    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(localStorage.getItem(REMEMBER_STORAGE_KEY)).toBeNull();
  });

  it("keeps an opted-out session within the same browser session", () => {
    localStorage.setItem(REMEMBER_STORAGE_KEY, "false");
    sessionStorage.setItem(SESSION_ACTIVE_KEY, "1");

    applyRememberPreference("https://jitsu.au/account");

    expect(signOut).not.toHaveBeenCalled();
  });

  it("leaves a remembered session alone and marks the browser session active", () => {
    localStorage.setItem(REMEMBER_STORAGE_KEY, "true");

    applyRememberPreference("https://jitsu.au/account");

    expect(signOut).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(SESSION_ACTIVE_KEY)).toBe("1");
  });
});
