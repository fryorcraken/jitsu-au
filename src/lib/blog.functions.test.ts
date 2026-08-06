// `resolvePostSlug` and `resolvePublishedAt` are the pieces of blog.functions.ts
// reachable from a unit test without a Start request context (the
// `createServerFn` handlers die on "No Start context found in
// AsyncLocalStorage" when called from the runner — see
// waiver.functions.test.ts). Both take their inputs as plain parameters for
// exactly that reason.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { resolveExcerpt, resolvePostSlug, resolvePublishedAt } from "./blog.functions";

/**
 * A minimal chainable stub covering the one query shape `resolvePostSlug`
 * walks: `.from("blog_posts").select("slug").ilike(...)`, optionally
 * `.neq(...)`, awaited directly (a thenable, like the real Postgrest builder).
 */
function fakeAdmin(existingSlugs: string[]) {
  const builder = {
    select: () => builder,
    ilike: () => builder,
    neq: () => builder,
    then: (resolve: (r: { data: { slug: string }[]; error: null }) => void) =>
      resolve({ data: existingSlugs.map((slug) => ({ slug })), error: null }),
  };
  return { from: () => builder } as unknown as SupabaseClient<Database>;
}

describe("resolvePostSlug", () => {
  it("derives a slug from the title when none is given", async () => {
    const admin = fakeAdmin([]);
    expect(await resolvePostSlug(admin, "Hello World", undefined)).toBe("hello-world");
  });

  it("uses the manager's own slug when given", async () => {
    const admin = fakeAdmin([]);
    expect(await resolvePostSlug(admin, "Hello World", "custom-url")).toBe("custom-url");
  });

  it("resolves a collision against another post's slug", async () => {
    const admin = fakeAdmin(["hello-world"]);
    expect(await resolvePostSlug(admin, "Hello World", undefined)).toBe("hello-world-2");
  });

  it("throws when the title has no usable characters and no slug was given", async () => {
    const admin = fakeAdmin([]);
    await expect(resolvePostSlug(admin, "!!!", undefined)).rejects.toThrow();
  });
});

describe("resolvePublishedAt", () => {
  const now = "2026-07-31T00:00:00.000Z";

  it("stamps the current time when a draft is published for the first time", () => {
    expect(resolvePublishedAt(null, "published", now)).toBe(now);
  });

  it("stays null when a draft is saved as a draft", () => {
    expect(resolvePublishedAt(null, "draft", now)).toBeNull();
  });

  it("keeps the original publish date when re-saving an already-published post", () => {
    const original = "2026-01-01T00:00:00.000Z";
    expect(resolvePublishedAt(original, "published", now)).toBe(original);
  });

  it("keeps the original publish date when unpublishing back to draft", () => {
    const original = "2026-01-01T00:00:00.000Z";
    expect(resolvePublishedAt(original, "draft", now)).toBe(original);
  });

  it("does not re-date a post republished after being unpublished", () => {
    const original = "2026-01-01T00:00:00.000Z";
    // Simulates: publish -> unpublish -> publish again. `published_at` was
    // already set on the first publish and must never move, or the post
    // would silently jump to the top of the public list on republish.
    expect(resolvePublishedAt(original, "draft", now)).toBe(original);
    expect(resolvePublishedAt(original, "published", now)).toBe(original);
  });
});

describe("resolveExcerpt", () => {
  it("keeps what the manager typed", () => {
    expect(resolveExcerpt("Hand-written summary.", "Body text.")).toBe("Hand-written summary.");
  });

  it("derives one from the body when the field was left blank", () => {
    expect(resolveExcerpt("", "# Grading day\n\nEveryone passed.")).toBe("Everyone passed.");
    expect(resolveExcerpt(undefined, "Everyone passed.")).toBe("Everyone passed.");
  });

  it("treats a whitespace-only excerpt as blank rather than storing it", () => {
    expect(resolveExcerpt("   ", "Everyone passed.")).toBe("Everyone passed.");
  });

  it("stores null when there is nothing to derive either", () => {
    expect(resolveExcerpt("", "[[video:https://youtu.be/abc]]")).toBeNull();
  });
});
