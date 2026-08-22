import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { applySecurityHeaders } from "./lib/security-headers";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(
  response: Response,
  pathname: string,
): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return errorResponse(pathname);
}

// The error page is built out here, past the request middleware in start.ts, so
// it has to set its own headers. It carries a link home, and on
// /email-settings/<token> a click on that link would otherwise hand the token
// to the next page in a same-origin `Referer`.
function errorResponse(pathname: string): Response {
  return applySecurityHeaders(
    new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
    pathname,
  );
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    // Parsed inside the guard, not above it. Before the security headers this
    // function never touched the URL, so the try covered everything it did; a
    // `new URL()` hoisted out would be the one fallible call that could throw
    // past it, and the reply to that is whatever bare error the runtime makes,
    // with none of the headers this file exists to guarantee. `new URL()` is
    // hard to make throw on a real request, which is the argument for keeping
    // it cheap to be right rather than for assuming it cannot.
    let pathname = "/";
    try {
      pathname = new URL(request.url).pathname;
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response, pathname);
    } catch (error) {
      console.error(error);
      return errorResponse(pathname);
    }
  },
};
