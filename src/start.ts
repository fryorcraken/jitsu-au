import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import {
  SITE_GATE_COOKIE,
  SITE_GATE_PATH,
  buildGateCookie,
  gateStamp,
  isGateExempt,
  readCookie,
  renderGatePage,
  safeRedirectPath,
} from "./lib/site-gate";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

// Shared-password gate for the pre-launch site, so a stray visitor doesn't take
// it for the real thing. Off unless SITE_PASSWORD is set. See lib/site-gate.ts.
const siteGateMiddleware = createMiddleware().server(async ({ next, request, pathname }) => {
  const password = process.env.SITE_PASSWORD?.trim();
  if (!password) return next();
  if (isGateExempt(pathname)) return next();

  const stamp = gateStamp(password);
  if (readCookie(request.headers.get("cookie"), SITE_GATE_COOKIE) === stamp) return next();

  const gatePage = (redirectTo: string, failed: boolean) =>
    new Response(renderGatePage({ redirectTo, failed }), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });

  if (request.method === "POST" && pathname === SITE_GATE_PATH) {
    const form = await request.formData();
    const redirectTo = safeRedirectPath(String(form.get("redirect") ?? "/"));
    if (String(form.get("password") ?? "") !== password) return gatePage(redirectTo, true);
    return new Response(null, {
      status: 303,
      headers: {
        location: redirectTo,
        "set-cookie": buildGateCookie(stamp, new URL(request.url).protocol === "https:"),
        "cache-control": "no-store",
      },
    });
  }

  // The gate path itself is not a route, so send those visitors home instead.
  const url = new URL(request.url);
  return gatePage(pathname === SITE_GATE_PATH ? "/" : `${url.pathname}${url.search}`, false);
});

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth],
  requestMiddleware: [errorMiddleware, siteGateMiddleware],
}));
