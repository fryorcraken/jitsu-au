import { describe, expect, it, vi } from "vitest";
import {
  BlogImageError,
  blogImageFileName,
  blogImageMarkdown,
  blogImageUrlProblem,
  fetchBlogImage,
  sniffBlogImageType,
} from "./blog-image";

const bytes = (...b: number[]) => Uint8Array.from(b);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);

describe("sniffBlogImageType", () => {
  it("reads each of the four formats off its own bytes", () => {
    expect(sniffBlogImageType(PNG)).toBe("image/png");
    expect(sniffBlogImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffBlogImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif");
    expect(
      sniffBlogImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50)),
    ).toBe("image/webp");
  });

  // A WAV file is RIFF too. Only the WEBP tag makes it a picture.
  it("does not take any RIFF file for a WebP", () => {
    expect(
      sniffBlogImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45)),
    ).toBeNull();
  });

  it("refuses anything else, whatever it claims to be", () => {
    expect(sniffBlogImageType(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    expect(sniffBlogImageType(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
    expect(sniffBlogImageType(bytes())).toBeNull();
  });
});

describe("blogImageFileName", () => {
  it("keeps a name that already has an extension", () => {
    expect(blogImageFileName("image/png", "mat.png")).toBe("mat.png");
  });

  it("adds the extension of what the bytes really are", () => {
    expect(blogImageFileName("image/jpeg", "mat")).toBe("mat.jpg");
  });

  it("falls back to the address, then to image", () => {
    expect(blogImageFileName("image/png", undefined, "https://x.example.com/a/b%20c.png?s=1")).toBe(
      "b c.png",
    );
    expect(blogImageFileName("image/webp", undefined, "https://x.example.com/")).toBe("image.webp");
    expect(blogImageFileName("image/gif", "  ")).toBe("image.gif");
  });
});

describe("blogImageMarkdown", () => {
  it("writes the same image the composer inserts", () => {
    expect(blogImageMarkdown("The mats", "https://cdn.example.com/a.png")).toBe(
      "![The mats](https://cdn.example.com/a.png)",
    );
  });

  // A closing bracket in the alt text would end the image early and print the
  // rest of the line as text.
  it("drops brackets that would break the image", () => {
    expect(blogImageMarkdown("Belts [all of them]", "u")).toBe("![Belts all of them](u)");
  });
});

describe("blogImageUrlProblem", () => {
  it("accepts a public https address", () => {
    expect(blogImageUrlProblem("https://images.example.com/belt.png")).toBeNull();
  });

  it.each([
    ["http://images.example.com/belt.png", "https"],
    ["https://user:pw@images.example.com/belt.png", "login"],
    ["https://169.254.169.254/latest", "IP"],
    ["https://[::1]/x.png", "IP"],
    ["https://localhost/x.png", "public"],
    ["https://db.internal/x.png", "public"],
    ["https://printer/x.png", "public"],
    ["not a url", "web address"],
  ])("refuses %s", (url, says) => {
    expect(blogImageUrlProblem(url)).toContain(says);
  });
});

describe("fetchBlogImage", () => {
  it("returns the bytes and where they came from", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(PNG));
    const got = await fetchBlogImage("https://a.example.com/x.png", fetchImpl);
    expect(got.bytes).toEqual(PNG);
    expect(got.finalUrl).toBe("https://a.example.com/x.png");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("follows a redirect to another public address", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/y.png" } }))
      .mockResolvedValueOnce(new Response(PNG));
    const got = await fetchBlogImage("https://a.example.com/x.png", fetchImpl);
    expect(got.finalUrl).toBe("https://a.example.com/y.png");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // The hop is checked BEFORE it is requested, which is the point of
  // following redirects by hand rather than letting fetch do it.
  it("refuses a redirect towards a private address without requesting it", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 301,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      }),
    );
    await expect(fetchBlogImage("https://a.example.com/x.png", fetchImpl)).rejects.toMatchObject({
      reason: "rejected",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after five redirects", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/again" } }),
    );
    await expect(fetchBlogImage("https://a.example.com/x", fetchImpl)).rejects.toThrow(
      /too many times/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("stops reading at the size cap", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new Uint8Array(20)));
    await expect(
      fetchBlogImage("https://a.example.com/x.png", fetchImpl, 10),
    ).rejects.toMatchObject({ reason: "rejected", message: expect.stringMatching(/too large/) });
  });

  it("sorts an error answer into one to retry and one to change", async () => {
    const server = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    const missing = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    await expect(fetchBlogImage("https://a.example.com/x", server)).rejects.toMatchObject({
      reason: "unreachable",
    });
    await expect(fetchBlogImage("https://a.example.com/x", missing)).rejects.toMatchObject({
      reason: "rejected",
    });
  });

  it("reports a network failure as unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const err = await fetchBlogImage("https://a.example.com/x", fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(BlogImageError);
    expect(err.reason).toBe("unreachable");
  });
});
