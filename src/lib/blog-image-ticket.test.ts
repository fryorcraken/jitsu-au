import { describe, expect, it } from "vitest";
import {
  assertBlogImageTicketLive,
  BLOG_IMAGE_TICKET_PREFIX,
  BLOG_IMAGE_TICKET_TTL_MINUTES,
  BlogImageTicketError,
  blogImageUploadCommand,
  newBlogImageTicket,
  readBlogImageTicket,
  signBlogImageTicket,
} from "./blog-image-ticket";

const SECRET = "test-service-role-key";
const ISSUER = "44444444-4444-4444-4444-444444444444";
const POST = "7d2b5e30-1caf-4e4d-a091-3c4d5e6f7081";
const NOW = Date.UTC(2026, 9, 30, 1, 0, 0);

async function refusal(p: Promise<unknown>) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(BlogImageTicketError);
  return e as BlogImageTicketError;
}

describe("blog image upload tickets", () => {
  it("reads back what was signed, for an hour", async () => {
    const ticket = newBlogImageTicket(
      ISSUER,
      { post_id: POST, name: "mats.jpg", alt: "The mats" },
      NOW,
    );
    expect(ticket.expires_at - NOW).toBe(60 * 60_000);
    expect(BLOG_IMAGE_TICKET_TTL_MINUTES).toBe(60);
    const token = await signBlogImageTicket(SECRET, ticket);
    expect(token.startsWith(BLOG_IMAGE_TICKET_PREFIX)).toBe(true);
    const read = await readBlogImageTicket(SECRET, token);
    expect(read).toEqual(ticket);
    expect(() => assertBlogImageTicketLive(read, NOW + 59 * 60_000)).not.toThrow();
  });

  it("gives every link its own id", () => {
    const a = newBlogImageTicket(ISSUER, {}, NOW);
    const b = newBlogImageTicket(ISSUER, {}, NOW);
    expect(a.id).not.toBe(b.id);
    expect(a).not.toHaveProperty("post_id");
  });

  // Expiry is a separate check from the signature, so a used link can still
  // be answered with what it stored after its hour is up.
  it("stops working when the hour is up, but can still be read", async () => {
    const token = await signBlogImageTicket(SECRET, newBlogImageTicket(ISSUER, {}, NOW));
    const read = await readBlogImageTicket(SECRET, token);
    let e: unknown;
    try {
      assertBlogImageTicketLive(read, NOW + 60 * 60_000 + 1000);
    } catch (err) {
      e = err;
    }
    expect(e).toBeInstanceOf(BlogImageTicketError);
    expect((e as BlogImageTicketError).reason).toBe("expired");
    expect((e as BlogImageTicketError).message).toMatch(/start_blog_image_upload/);
  });

  // The whole point of the signature: the contents are the caller's to read,
  // never to change. A ticket for somebody else's id, a later expiry or another
  // issuer must be refused, not honoured.
  it("refuses a ticket whose contents were changed", async () => {
    const token = await signBlogImageTicket(SECRET, newBlogImageTicket(ISSUER, {}, NOW));
    const [body, sig] = token.slice(BLOG_IMAGE_TICKET_PREFIX.length).split(".");
    const wire = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    const forged = btoa(JSON.stringify({ ...wire, e: wire.e + 86_400 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const e = await refusal(
      readBlogImageTicket(SECRET, `${BLOG_IMAGE_TICKET_PREFIX}${forged}.${sig}`),
    );
    expect(e.reason).toBe("invalid");
  });

  it("refuses a ticket signed with another key", async () => {
    const token = await signBlogImageTicket("another-key", newBlogImageTicket(ISSUER, {}, NOW));
    expect((await refusal(readBlogImageTicket(SECRET, token))).reason).toBe("invalid");
  });

  it.each([
    ["a manager API token", "utsj_0123456789abcdef0123456789abcdef0123456789abcdef"],
    ["no signature", `${BLOG_IMAGE_TICKET_PREFIX}abc`],
    ["an extra part", `${BLOG_IMAGE_TICKET_PREFIX}a.b.c`],
    ["characters outside base64url", `${BLOG_IMAGE_TICKET_PREFIX}a+b.c/d`],
    ["nothing", ""],
  ])("refuses %s", async (_label, token) => {
    expect((await refusal(readBlogImageTicket(SECRET, token))).reason).toBe("invalid");
  });

  it("will not sign with no secret", async () => {
    await expect(signBlogImageTicket("", newBlogImageTicket(ISSUER, {}, NOW))).rejects.toThrow();
  });

  it("gives a command that sends the file's bytes as they are", () => {
    const cmd = blogImageUploadCommand(
      "https://utsjitsu.com.au/api/manager/blog-image",
      "utsu_x.y",
    );
    expect(cmd).toContain("--data-binary '@IMAGE_FILE'");
    expect(cmd).toContain("-H 'Authorization: Bearer utsu_x.y'");
    expect(cmd.endsWith("'https://utsjitsu.com.au/api/manager/blog-image'")).toBe(true);
  });
});
