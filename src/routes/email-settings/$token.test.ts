import { describe, it, expect } from "vitest";

import { Route } from "./$token";
import {
  EMAIL_SETTINGS_COOKIE,
  EMAIL_SETTINGS_MAX_AGE_SECONDS,
  readEmailSettingsToken,
} from "@/lib/email-settings-session";

type Handler = (ctx: {
  params: { token: string };
  request: Request;
}) => Response | Promise<Response>;

const handlers = (Route.options as { server?: { handlers?: { GET?: Handler } } }).server?.handlers;
const GET = handlers?.GET as Handler;

/** Open the emailed link, exactly as a mail client would. */
async function open(token: string, origin = "https://jitsu.au"): Promise<Response> {
  const url = `${origin}/email-settings/${encodeURIComponent(token)}`;
  return GET({ params: { token }, request: new Request(url) });
}

/** The Set-Cookie the response carries. */
function setCookie(response: Response): string {
  return response.headers.get("set-cookie") ?? "";
}

describe("GET /email-settings/<token>", () => {
  it("is wired up as a server handler, not a page", () => {
    // The whole point of this route is that nobody ever looks at it. A
    // component here would mean the token was back in the address bar.
    expect(typeof GET).toBe("function");
    expect((Route.options as { component?: unknown }).component).toBeUndefined();
  });

  it("sends the browser to the page with no token in the URL", async () => {
    const response = await open("utsj_abc123");
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe("https://jitsu.au/email-settings");
    expect(location).not.toContain("utsj_abc123");
  });

  it("hands the token over in the cookie instead", async () => {
    const response = await open("utsj_abc123");
    expect(readEmailSettingsToken(setCookie(response).split(";")[0])).toBe("utsj_abc123");
    expect(setCookie(response)).toContain(`Max-Age=${EMAIL_SETTINGS_MAX_AGE_SECONDS}`);
    expect(setCookie(response)).toContain("HttpOnly");
  });

  it("never lets a redirect carrying a Set-Cookie be cached", async () => {
    // A cached one would hand the first person's settings link to the next.
    expect((await open("utsj_abc123")).headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the response body empty, so nothing is on screen to read", async () => {
    expect(await (await open("utsj_abc123")).text()).toBe("");
  });

  it("drops the Secure attribute over plain http, so dev and e2e can open it", async () => {
    const secure = setCookie(await open("utsj_abc", "https://jitsu.au"));
    const local = setCookie(await open("utsj_abc", "http://localhost:4173"));
    expect(secure).toContain("Secure");
    expect(local).not.toContain("Secure");
    expect(local).toContain("HttpOnly");
  });

  it("answers a token that cannot be carried exactly the same way", async () => {
    // Uniform on purpose: a different answer here would turn this endpoint into
    // a way to probe which links the club has issued.
    for (const token of ["", "   ", "x".repeat(500)]) {
      const response = await open(token);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("https://jitsu.au/email-settings");
    }
  });

  it("clears any cookie already there when the link cannot be exchanged", async () => {
    // Otherwise a broken link would leave somebody looking at whichever
    // person's settings this browser last opened.
    const response = await open("");
    expect(setCookie(response)).toContain("Max-Age=0");
    expect(setCookie(response).startsWith(`${EMAIL_SETTINGS_COOKIE}=;`)).toBe(true);
  });

  it("cannot be made to write a second response header", async () => {
    const response = await open("evil\r\nSet-Cookie: admin=1");
    expect(setCookie(response)).not.toMatch(/[\r\n]/);
  });
});
