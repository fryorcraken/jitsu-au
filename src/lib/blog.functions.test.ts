// `resolvePostSlug` is the one piece of blog.functions.ts reachable from a unit
// test without a Start request context (the `createServerFn` handlers die on
// "No Start context found in AsyncLocalStorage" when called from the runner —
// see waiver.functions.test.ts). It takes its admin client as a parameter for
// exactly that reason.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { resolvePostSlug } from "./blog.functions";

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
