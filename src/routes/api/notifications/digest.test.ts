// Route-handler coverage for the digest endpoint's auth: the two states that
// used to be indistinguishable from "the digest just isn't sending anything"
// (an absent Vault secret, and a caller sending the wrong one), plus the
// module-scope cache that keeps a night of traffic to one Vault round trip.
// sendDailyDigests's own behaviour is covered in notification-email.server's
// own tests; what this file owns is which HTTP status each auth outcome
// becomes, and when the RPC that backs it is (and isn't) called again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REAL_KEY = "correct-vault-key";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {},
}));

const notificationDigestKeyMock = vi.fn();
vi.mock("@/lib/supabase-rpc", () => ({
  notificationDigestKey: (...args: unknown[]) => notificationDigestKeyMock(...args),
}));

const sendDailyDigestsMock = vi.fn();
vi.mock("@/lib/notification-email.server", () => ({
  sendDailyDigests: (...args: unknown[]) => sendDailyDigestsMock(...args),
}));

type RouteHandler = (ctx: { request: Request }) => Promise<Response>;

async function handler(): Promise<RouteHandler> {
  const { Route } = await import("./digest");
  return (Route as unknown as { options: { server: { handlers: { POST: RouteHandler } } } }).options
    .server.handlers.POST;
}

function post(token?: string) {
  return handler().then((h) =>
    h({
      request: new Request("http://localhost/api/notifications/digest", {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    }),
  );
}

describe("notifications digest route", () => {
  beforeEach(() => {
    vi.resetModules();
    notificationDigestKeyMock.mockReset();
    sendDailyDigestsMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a request with no bearer token before ever touching Vault", async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect(notificationDigestKeyMock).not.toHaveBeenCalled();
  });

  it("answers 503, not 401, when no secret has been minted in Vault", async () => {
    notificationDigestKeyMock.mockResolvedValue({ data: null, error: null });
    const res = await post("whatever");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/not configured/i);
    expect(sendDailyDigestsMock).not.toHaveBeenCalled();
  });

  it("answers 401 for a token that does not match the Vault secret", async () => {
    notificationDigestKeyMock.mockResolvedValue({ data: REAL_KEY, error: null });
    const res = await post("wrong-token");
    expect(res.status).toBe(401);
    expect(sendDailyDigestsMock).not.toHaveBeenCalled();
  });

  it("runs the digest for the correct token", async () => {
    notificationDigestKeyMock.mockResolvedValue({ data: REAL_KEY, error: null });
    sendDailyDigestsMock.mockResolvedValue({ considered: 3, recipients: 2, sent: 2 });
    const res = await post(REAL_KEY);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, considered: 3, recipients: 2, sent: 2 });
  });

  it("treats a Vault read failure the same as an unminted secret (503)", async () => {
    notificationDigestKeyMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = await post("whatever");
    expect(res.status).toBe(503);
    expect(sendDailyDigestsMock).not.toHaveBeenCalled();
  });

  it("reads Vault once per request even across multiple calls that both send a token", async () => {
    // Within one loaded module instance the cache should mean a second correct
    // request does not re-read Vault. Both requests go through the same
    // `handler()` import (no vi.resetModules() between them) to exercise that.
    notificationDigestKeyMock.mockResolvedValue({ data: REAL_KEY, error: null });
    sendDailyDigestsMock.mockResolvedValue({ considered: 0, recipients: 0, sent: 0 });
    const h = await handler();
    const req = () =>
      h({
        request: new Request("http://localhost/api/notifications/digest", {
          method: "POST",
          headers: { authorization: `Bearer ${REAL_KEY}` },
        }),
      });
    await req();
    await req();
    expect(notificationDigestKeyMock).toHaveBeenCalledTimes(1);
    expect(sendDailyDigestsMock).toHaveBeenCalledTimes(2);
  });
});
