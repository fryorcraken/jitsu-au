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

const EXTENSION: Record<BlogImageMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * The file name to store an image under: the caller's own, else the last part
 * of the address it came from, else "image". Given the extension of what the
 * bytes really are when it has none, so the stored key says what it holds.
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
  base = base.trim() || "image";
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${EXTENSION[type]}`;
}

/**
 * The Markdown that shows an image in a post body, the same shape the
 * composer's "Insert image" writes. Square brackets in the alt text would close
 * the image early, so they are dropped.
 */
export function blogImageMarkdown(alt: string, url: string): string {
  return `![${alt.replace(/[[\]]/g, "").trim()}](${url})`;
}

const PRIVATE_HOST = /(^|\.)(localhost|local|internal|localdomain|home|lan|intranet)$/i;

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
  const host = url.hostname;
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
        headers: { accept: "image/png,image/jpeg,image/webp,image/gif" },
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new BlogImageError(
        "unreachable",
        timedOut
          ? "The image took too long to download. Try again, or send the file itself."
          : "Could not download the image from that address. Check it opens in a browser, or send the file itself.",
      );
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new BlogImageError("unreachable", "The address redirected without saying where.");
      }
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) {
      throw new BlogImageError(
        res.status >= 500 ? "unreachable" : "rejected",
        `The address answered ${res.status} rather than an image. Check it opens in a browser without signing in.`,
      );
    }
    return { bytes: await readCapped(res, cap), finalUrl: current };
  }
  throw new BlogImageError("rejected", "The address redirected too many times.");
}
