// Where to send somebody after they sign in, from an untrusted `?redirect=`.
//
// Only a same-origin path survives, with its query and fragment intact: the
// MCP consent page needs its `authorization_id` back, or connecting an
// assistant silently fails. A network path (`//evil.example`), a backslash
// form (`/\evil.example`) or a control character falls back instead, so the
// sign-in page cannot be used to bounce somebody off-site.
export function oauthReturnPath(value: unknown, fallback = "/"): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    // eslint-disable-next-line no-control-regex
    /[\\\u0000-\u001f\u007f]/.test(value)
  ) {
    return fallback;
  }
  // A fixed parsing origin keeps this safe during SSR, where there is no window.
  const origin = "https://app.invalid";
  try {
    const target = new URL(value, origin);
    if (target.origin !== origin || target.pathname.startsWith("//")) return fallback;
    return target.pathname + target.search + target.hash;
  } catch {
    return fallback;
  }
}
