/**
 * The current request's headers, when the server runtime exposes them.
 *
 * Never throws: outside a request (a unit test, a script) it hands back a
 * getter that answers `undefined` for everything. The import is lazy, so a
 * `*.functions.ts` module, which is bundled to the client too, can use this
 * without pulling the server runtime into the browser.
 *
 * One copy, because what it feeds has to agree: the address a public form's
 * rate limit counts by and the address recorded on a waiver or an agreement
 * both come from `clientIp` over these headers.
 */
export async function requestHeaderGetter(): Promise<(name: string) => string | undefined> {
  try {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    // Guarded per call too: the import succeeds anywhere, but reading a header
    // outside a request throws.
    return (name: string) => {
      try {
        return getRequestHeader(name);
      } catch {
        return undefined;
      }
    };
  } catch {
    return () => undefined;
  }
}
