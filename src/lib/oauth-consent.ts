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
  /** Something we could not parse, or a scheme no real app uses. Approve is disabled. */
  | { kind: "unknown" };

const LOOPBACK_HOSTS = new Set(["localhost", "[::1]"]);

function isLoopback(rawHostname: string): boolean {
  // A trailing dot names the same host ("localhost." is localhost).
  const hostname = rawHostname.replace(/\.$/, "");
  return (
    LOOPBACK_HOSTS.has(hostname) ||
    hostname.endsWith(".localhost") ||
    /^127(\.\d{1,3}){3}$/.test(hostname) ||
    // 127.x.x.x written as an IPv4-mapped IPv6 address, which the URL parser
    // normalises to hex: [::ffff:127.0.0.1] becomes [::ffff:7f00:1].
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname)
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
