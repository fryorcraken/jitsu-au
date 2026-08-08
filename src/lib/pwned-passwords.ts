// "Has this password already leaked?", asked without telling anyone the password.
//
// Have I Been Pwned's range API is a k-anonymity scheme: we SHA-1 the password,
// send the first five hex characters of the hash, and get back every suffix
// that shares that prefix (a few hundred to a few thousand) along with how many
// times each has been seen in a breach. The matching happens here, in the
// browser. The password never leaves the device, and neither does its full
// hash, so the service cannot tell which of the returned entries we were asking
// about.
//
// The `Add-Padding` request header is part of that: without it the SIZE of the
// response is itself a signal, because a prefix with few matches returns a
// small body. With it every response is padded with decoy entries to a uniform
// bulk, and the decoys carry a count of 0, which is why a match is only a match
// when its count is above zero.
//
// SHA-1 here is not a security choice we are making. It is the index HIBP is
// built on, it is used as a lookup key rather than to protect anything, and
// nothing about the scheme relies on it being collision resistant.
//
// This is advisory. Supabase runs the same check server side when the password
// is saved and that is what actually enforces it. Everything here exists so the
// answer arrives while somebody is still typing, and every failure path returns
// "unknown" rather than blocking them.

const RANGE_URL = "https://api.pwnedpasswords.com/range/";

export type BreachLookup = "safe" | "breached" | "unknown";

async function sha1Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * Whether this password appears in Have I Been Pwned's breach corpus.
 *
 * Returns "unknown" for every failure, including an aborted request: no
 * network, a blocked request, an old browser without WebCrypto, HIBP being
 * down. A caller must treat "unknown" as "carry on", never as a rejection.
 */
export async function lookupBreachedPassword(
  password: string,
  signal?: AbortSignal,
): Promise<BreachLookup> {
  // Requires a secure context, so it is absent on plain http and in some test
  // environments. Nothing to do about it beyond not crashing.
  if (typeof crypto === "undefined" || !crypto.subtle) return "unknown";

  try {
    const hash = await sha1Hex(password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);

    const response = await fetch(`${RANGE_URL}${prefix}`, {
      signal,
      headers: { "Add-Padding": "true" },
    });
    if (!response.ok) return "unknown";

    for (const line of (await response.text()).split("\n")) {
      const [candidate, count] = line.trim().split(":");
      if (candidate !== suffix) continue;
      // A count of 0 is padding, not a sighting.
      return Number(count) > 0 ? "breached" : "safe";
    }
    // The prefix came back and our suffix was not in it, which is a real answer.
    return "safe";
  } catch {
    return "unknown";
  }
}
