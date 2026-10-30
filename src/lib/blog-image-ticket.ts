// Upload links for blog images: how an assistant whose only way to reach the
// club is MCP gets a full-size photo into a post.
//
// The problem: an MCP tool call is text the model types. Claude on the web has
// the photo as a file in its sandbox, but the only way to hand it to
// `upload_blog_image` is to type out its base64, which for a real photo is
// tens of thousands of characters the model has to copy without a slip. The
// sandbox CAN make an ordinary HTTPS request, though. So the
// `start_blog_image_upload` action hands back a link, and the sandbox sends the
// file's bytes to it (`POST /api/manager/blog-image`, curl --data-binary).
//
// What the link is allowed to be, and why:
//
// - **It is not the manager's credential.** The sandbox is a different machine
//   from the MCP client, and whatever the model is given ends up in the chat
//   transcript. Handing it an OAuth session or a minted API token would put a
//   full manager login in a transcript. A ticket reaches exactly one thing:
//   storing one image in the blog bucket, which shows nowhere until a post is
//   saved with it.
// - **It works once.** The ticket carries a random id, and the image is stored
//   under `<folder>/<id>-<name>`. The upload looks for that id before storing,
//   so a second upload with the same ticket is refused, and is told the path of
//   the image the first one stored (that is usually a retry whose answer was
//   lost, and the image it wanted is already there). No database table is
//   needed: the bucket itself records that the link was used. That answer is
//   given even after the link has expired, so a retry that arrives late is not
//   told to start again and store a second copy.
//
//   The one gap, accepted: the image's extension comes from its bytes, so two
//   uploads RACING on one link with files of different types land at
//   different names and both are stored. Only the link's holder can do that,
//   and all it costs is an unused file in the bucket.
// - **It lasts an hour** (`BLOG_IMAGE_TICKET_TTL_MINUTES`), long enough for a
//   slow phone connection, short enough that a ticket left in a transcript is
//   dead by the time anyone reads it.
// - **It answers to its issuer's role today.** The upload re-checks that the
//   manager who asked for the link still holds the role, as a minted API token
//   does on every call. It is NOT tied to the credential it was asked for with:
//   revoking a leaked API token (or an assistant's sign-in) leaves the links
//   already minted with it working until their hour is up. Closing that would
//   mean a ticket naming its token and a lookup per upload, and what it guards
//   is an hour of storing pictures that show nowhere until a manager publishes
//   them, so it is accepted. Removing somebody's manager role does void them.
//
// The ticket is signed rather than stored: an HMAC over its contents, with a
// key derived (HKDF, a fixed label) from the service-role key, which only the
// server holds. The derivation keeps the two uses apart, so a ticket's
// signature says nothing about the key it came from. Rotating the service-role
// key voids every outstanding ticket, which for an hour-long link is fine.
//
// Pure apart from Web Crypto, so all of it runs under the unit tests.
import { z } from "zod";
import { webCrypto } from "@/lib/manager-api-tokens";

/** Human-recognisable prefix, distinct from a manager API token's `utsj_`. */
export const BLOG_IMAGE_TICKET_PREFIX = "utsu_";

/** How long an upload link works for. */
export const BLOG_IMAGE_TICKET_TTL_MINUTES = 60;

/** The HKDF label. Changing it voids every outstanding ticket. */
const KEY_LABEL = "uts-jitsu blog image upload ticket v1";

/** What a ticket says. Short keys on the wire, because it travels in a header. */
export type BlogImageTicket = {
  /** Random; the stored image's name starts with it. */
  id: string;
  /** The manager who asked for the link. */
  issuer: string;
  /** The post it is for, which only decides its folder. */
  post_id?: string;
  name?: string;
  alt?: string;
  /** When it stops working, in milliseconds since the epoch. */
  expires_at: number;
};

const wireSchema = z
  .object({
    v: z.literal(1),
    i: z.string().uuid(),
    u: z.string().uuid(),
    p: z.string().uuid().optional(),
    n: z.string().max(255).optional(),
    a: z.string().max(300).optional(),
    e: z.number().int().positive(),
  })
  .strict();

/** Why a ticket was not accepted. */
export class BlogImageTicketError extends Error {
  constructor(
    readonly reason: "invalid" | "expired",
    message: string,
  ) {
    super(message);
    this.name = "BlogImageTicketError";
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
}

/** The derived key per secret, so each request does not derive it again. */
const keys = new Map<string, Promise<CryptoKey>>();

function signingKey(secret: string): Promise<CryptoKey> {
  if (!secret) return Promise.reject(new Error("No secret to sign upload links with."));
  let key = keys.get(secret);
  if (!key) {
    key = deriveSigningKey(secret);
    // A failed derivation is not kept, or it would fail every later request.
    key.catch(() => keys.delete(secret));
    keys.set(secret, key);
  }
  return key;
}

async function deriveSigningKey(secret: string): Promise<CryptoKey> {
  const subtle = webCrypto().subtle;
  const base = await subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(KEY_LABEL),
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

/** A fresh ticket's contents: a new id, expiring an hour from `now`. */
export function newBlogImageTicket(
  issuer: string,
  file: { post_id?: string; name?: string; alt?: string },
  now: number = Date.now(),
): BlogImageTicket {
  return {
    id: webCrypto().randomUUID(),
    issuer,
    ...(file.post_id && { post_id: file.post_id }),
    ...(file.name && { name: file.name }),
    ...(file.alt && { alt: file.alt }),
    expires_at: now + BLOG_IMAGE_TICKET_TTL_MINUTES * 60_000,
  };
}

/** The ticket as the bearer token the upload takes: `utsu_<contents>.<signature>`. */
export async function signBlogImageTicket(
  secret: string,
  ticket: BlogImageTicket,
): Promise<string> {
  const wire = {
    v: 1 as const,
    i: ticket.id,
    u: ticket.issuer,
    ...(ticket.post_id && { p: ticket.post_id }),
    ...(ticket.name && { n: ticket.name }),
    ...(ticket.alt && { a: ticket.alt }),
    // Seconds, rounded up, so a ticket never lasts less than it says.
    e: Math.ceil(ticket.expires_at / 1000),
  };
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(wire)));
  const sig = await webCrypto().subtle.sign(
    "HMAC",
    await signingKey(secret),
    new TextEncoder().encode(body),
  );
  return `${BLOG_IMAGE_TICKET_PREFIX}${body}.${toBase64Url(new Uint8Array(sig))}`;
}

const INVALID = "That upload link is not valid. Ask for a new one with start_blog_image_upload.";

/**
 * The ticket a bearer token carries, once its signature is checked. Throws
 * `BlogImageTicketError("invalid")`. Says nothing about whether it has expired
 * (`assertBlogImageTicketLive`) or been used (the bucket's to answer), because
 * a used link is answered with what it stored, expired or not.
 */
export async function readBlogImageTicket(secret: string, token: string): Promise<BlogImageTicket> {
  if (!token.startsWith(BLOG_IMAGE_TICKET_PREFIX)) {
    throw new BlogImageTicketError("invalid", INVALID);
  }
  const [body, sig, extra] = token.slice(BLOG_IMAGE_TICKET_PREFIX.length).split(".");
  if (!body || !sig || extra !== undefined) throw new BlogImageTicketError("invalid", INVALID);
  let sigBytes: Uint8Array<ArrayBuffer>;
  let bodyBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(sig);
    bodyBytes = fromBase64Url(body);
  } catch {
    throw new BlogImageTicketError("invalid", INVALID);
  }
  // `verify` compares in constant time; the contents are not read until it passes.
  const genuine = await webCrypto().subtle.verify(
    "HMAC",
    await signingKey(secret),
    sigBytes,
    new TextEncoder().encode(body),
  );
  if (!genuine) throw new BlogImageTicketError("invalid", INVALID);
  let parsed: z.infer<typeof wireSchema>;
  try {
    parsed = wireSchema.parse(JSON.parse(new TextDecoder().decode(bodyBytes)));
  } catch {
    throw new BlogImageTicketError("invalid", INVALID);
  }
  return {
    id: parsed.i,
    issuer: parsed.u,
    ...(parsed.p && { post_id: parsed.p }),
    ...(parsed.n && { name: parsed.n }),
    ...(parsed.a && { alt: parsed.a }),
    expires_at: parsed.e * 1000,
  };
}

/** Throws `BlogImageTicketError("expired")` once the ticket's hour is up. */
export function assertBlogImageTicketLive(ticket: BlogImageTicket, now: number = Date.now()): void {
  if (ticket.expires_at <= now) {
    throw new BlogImageTicketError(
      "expired",
      `That upload link has expired (they last ${BLOG_IMAGE_TICKET_TTL_MINUTES} minutes). Ask for a new one with start_blog_image_upload.`,
    );
  }
}

/**
 * The command the assistant runs in its sandbox, after setting the shell
 * variable IMAGE_FILE to the file's path. The path is read from a variable,
 * not pasted into the command, because a phone's file names hold spaces and
 * apostrophes ("Sam's grading.jpg") that would end a quoted string early; a
 * double-quoted expansion passes any of them through. The token and the
 * address hold nothing a shell would expand, so they are single-quoted.
 */
export function blogImageUploadCommand(uploadUrl: string, token: string): string {
  return [
    "curl -sS -X POST",
    `-H 'Authorization: Bearer ${token}'`,
    "-H 'Content-Type: application/octet-stream'",
    '--data-binary "@$IMAGE_FILE"',
    `'${uploadUrl}'`,
  ].join(" ");
}
