// Where an assistant's access goes once a manager approves it.
//
// The name on the consent screen is whatever the assistant registered itself
// as, and assistants register themselves: anybody can call an app "Claude
// Code" and send a manager the link. What they cannot fake is the address the
// approval is sent to, because the OAuth server only ever redirects to the
// client's registered `redirect_uri`. So the screen names that address, and a
// manager who did not start connecting, or does not recognise it, has
// something to go on besides a name.
//
// Kept pure so each shape is unit-tested; the copy lives on the page.

export type RedirectTarget =
  /** A loopback address: a program on the manager's own computer (Claude Code, Cursor). */
  | { kind: "this-computer" }
  /** An ordinary website, named by its host. */
  | { kind: "website"; host: string }
  /** A custom scheme an installed app registers (`cursor:`, `vscode:`). */
  | { kind: "app"; scheme: string }
  /** Something we could not parse. The page says so rather than guessing. */
  | { kind: "unknown" };

const LOOPBACK_HOSTS = new Set(["localhost", "[::1]"]);

function isLoopback(hostname: string): boolean {
  return (
    LOOPBACK_HOSTS.has(hostname) ||
    hostname.endsWith(".localhost") ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

export function describeRedirectTarget(redirectUri: unknown): RedirectTarget {
  if (typeof redirectUri !== "string" || !redirectUri) return { kind: "unknown" };
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return { kind: "unknown" };
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (!url.hostname) return { kind: "unknown" };
    if (isLoopback(url.hostname)) return { kind: "this-computer" };
    return { kind: "website", host: url.host };
  }
  // Schemes that can carry script or data are never a real app's callback.
  const scheme = url.protocol.slice(0, -1);
  if (["javascript", "data", "blob", "file", "vbscript"].includes(scheme)) {
    return { kind: "unknown" };
  }
  return { kind: "app", scheme };
}
