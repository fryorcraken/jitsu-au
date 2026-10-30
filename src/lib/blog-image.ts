// Getting an image into a blog post from somewhere other than the composer's
// file picker: raw bytes an agent sends, or an address it points at. Used by
// the manager agent API's `upload_blog_image` (docs/manager-agent-api.md).
//
// Two things this defends against, and they are the reason it is a module:
//
// - **A declared type is not evidence.** The composer's picker hands the
//   browser's guess at a file's type to the server, and that is fine for a
//   manager choosing their own photo. An agent relays bytes it did not make and
//   addresses it did not check, so here the type is read off the bytes
//   themselves (`sniffBlogImageType`), and anything that is not one of the four
//   image formats a post may show is refused before it reaches the bucket.
// - **The server fetching an address it was handed.** An image by address is
//   the only practical route for an assistant over MCP (it cannot type out a
//   megabyte of base64), but it means the club's server makes a request on a
//   caller's say-so. So it is https only, to a named host (no IP literal, no
//   localhost or private suffix), every redirect hop is checked the same way
//   before it is followed, it gives up after a fixed time, and it stops reading
//   at the size cap rather than after downloading whatever was sent.
//
//   What it does NOT catch is a public-looking host name that resolves to a
//   private address: checking that needs a DNS lookup the runtime does not
//   offer. The deployed site runs on Cloudflare Workers, whose fetch cannot
//   reach a private network anyway, and only a manager's credential gets this
//   far. If the site ever moves to a host that can, this is the gap to close.
//
// Pure apart from `fetchBlogImage`'s use of the `fetch` it is handed, so all of
// it runs under the unit tests.
import { MAX_BLOG_IMAGE_BYTES, type BlogImageMimeType } from "@/lib/validation";

/**
 * Why an image was not taken. `rejected` means this image will never work and
 * the request has to change; `unreachable` means the address could not be read
 * just now, which may be worth another try.
 */
export class BlogImageError extends Error {
  constructor(
    readonly reason: "rejected" | "unreachable",
    message: string,
  ) {
    super(message);
    this.name = "BlogImageError";
  }
}

const startsWith = (bytes: Uint8Array, sig: number[], offset = 0) =>
  bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

/** The image format these bytes really are, or null when they are none of the four a post shows. */
export function sniffBlogImageType(bytes: Uint8Array): BlogImageMimeType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  return null;
}

/** The extensions each format is known by. The first is the one we write. */
const EXTENSIONS: Record<BlogImageMimeType, string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
};

/** Long enough for any real name; well inside a storage key's limit. */
const MAX_NAME_CHARS = 100;

/**
 * The file name to store an image under: the caller's own, else the last part
 * of the address it came from, else "image". Its extension is always one that
 * matches what the bytes really are, replacing one that does not
 * (`render.php`, a `logo.svg` that is really a PNG), so the stored key says
 * what it holds.
 */
export function blogImageFileName(
  type: BlogImageMimeType,
  name: string | undefined,
  sourceUrl?: string,
): string {
  let base = name?.trim() ?? "";
  if (!base && sourceUrl) {
    try {
      base = decodeURIComponent(new URL(sourceUrl).pathname.split("/").pop() ?? "");
    } catch {
      base = "";
    }
  }
  const found = /\.([a-z0-9]{1,5})$/i.exec(base)?.[1];
  if (found) base = base.slice(0, -(found.length + 1));
  const ext = EXTENSIONS[type].find((e) => e === found?.toLowerCase()) ?? EXTENSIONS[type][0];
  return `${base.trim().slice(0, MAX_NAME_CHARS) || "image"}.${ext}`;
}

/**
 * The Markdown that shows an image in a post body, the same shape the
 * composer's "Insert image" writes. Square brackets in the alt text would close
 * the image early, so they are dropped.
 */
export function blogImageMarkdown(alt: string, url: string): string {
  // A line break would split the image across paragraphs, and a backslash can
  // escape its closing bracket; neither belongs in a description.
  const clean = alt
    .replace(/[[\]\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `![${clean}](${url})`;
}

/**
 * Names that are private by convention or by standard (RFC 6761, 6762, 8375),
 * and the public wildcard-DNS services whose whole purpose is to resolve a name
 * to whatever address it spells (127.0.0.1.nip.io). A suffix list cannot see
 * where any other name resolves; see the header for why that gap is accepted.
 */
const PRIVATE_HOST =
  /(^|\.)(localhost|local|internal|localdomain|home|lan|intranet|corp|private|test|invalid|arpa|localtest\.me|nip\.io|sslip\.io|xip\.io)$/i;

/**
 * Whether the server may fetch this address on a caller's behalf. Returns the
 * reason it may not, or null when it may.
 */
export function blogImageUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a web address.";
  }
  if (url.protocol !== "https:") return "Only https addresses are fetched.";
  if (url.username || url.password) return "An address carrying a login is not fetched.";
  // Trailing dots are the same host written fully qualified ("localhost."),
  // and would otherwise slip past the suffix test below.
  const host = url.hostname.replace(/\.+$/, "");
  // An IP literal (v4 or bracketed v6) names a machine rather than a site, and
  // is how a request is pointed at something on a private network.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":")) {
    return "Give the image's web address with a host name, not an IP address.";
  }
  if (!host.includes(".") || PRIVATE_HOST.test(host)) {
    return "That address is not on the public internet.";
  }
  return null;
}

/** A failed request or read, as something the caller may retry. */
function unreachable(e: unknown): BlogImageError {
  // By name, not `instanceof Error`: an abort arrives as a DOMException, which
  // not every runtime makes an Error.
  const name = (e as { name?: unknown } | null)?.name;
  const timedOut = name === "TimeoutError" || name === "AbortError";
  return new BlogImageError(
    "unreachable",
    timedOut
      ? "The image took too long to download. Try again, or send the file itself."
      : "Could not download the image from that address. Check it opens in a browser, or send the file itself.",
  );
}

/** Who is asking, for an image host that wants to know. Names the site, nothing about the caller. */
const IMAGE_FETCH_USER_AGENT = "UTSJitsuBlogImageFetcher/1.0 (+https://utsjitsu.com.au)";

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;

/** Read a response body, stopping as soon as it passes the cap. */
async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const tooLarge = () =>
    new BlogImageError(
      "rejected",
      `That image is too large. Keep it under ${cap / 1024 / 1024} MB.`,
    );
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) throw tooLarge();
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Download an image from a public https address, following up to five
 * redirects and checking each hop before it is requested. Returns the bytes
 * and the address they finally came from. Throws `BlogImageError`.
 */
export async function fetchBlogImage(
  sourceUrl: string,
  fetchImpl: typeof fetch = fetch,
  cap: number = MAX_BLOG_IMAGE_BYTES,
): Promise<{ bytes: Uint8Array; finalUrl: string }> {
  let current = sourceUrl;
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const problem = blogImageUrlProblem(current);
    if (problem) {
      throw new BlogImageError(
        "rejected",
        hop === 0 ? problem : `The address redirected somewhere that is not fetched. ${problem}`,
      );
    }
    let res: Response;
    try {
      res = await fetchImpl(current, {
        redirect: "manual",
        signal,
        // Some image hosts (Wikimedia's among them) refuse a request that
        // names no client, and a Workers fetch sends none by default.
        headers: {
          accept: "image/png,image/jpeg,image/webp,image/gif",
          "user-agent": IMAGE_FETCH_USER_AGENT,
        },
      });
    } catch (e) {
      throw unreachable(e);
    }
    if (res.status >= 300 && res.status < 400) {
      // Release the connection before the next hop or the refusal.
      await res.body?.cancel().catch(() => {});
      const location = res.headers.get("location");
      let next: URL | null;
      try {
        next = location ? new URL(location, current) : null;
      } catch {
        next = null;
      }
      if (!next) {
        throw new BlogImageError("unreachable", "The address redirected without saying where.");
      }
      current = next.toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      // "Too slow" and "too many requests" pass with time; any other 4xx is
      // the address itself, which no retry changes.
      const passes = res.status >= 500 || res.status === 408 || res.status === 429;
      throw new BlogImageError(
        passes ? "unreachable" : "rejected",
        `The address answered ${res.status} rather than an image. Check it opens in a browser without signing in.`,
      );
    }
    try {
      return { bytes: await readCapped(res, cap), finalUrl: current };
    } catch (e) {
      // The timeout covers the body too: a host that sends its headers and
      // then trickles is as unreachable as one that never answered.
      throw e instanceof BlogImageError ? e : unreachable(e);
    }
  }
  throw new BlogImageError("rejected", "The address redirected too many times.");
}
