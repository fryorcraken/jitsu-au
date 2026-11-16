// Page one of the blog is `/blog`, never `/blog?page=1`. The sitemap lists
// `/blog` and the page names it as its canonical, so if the router writes the
// default page back into the address, `/blog` is answered with a redirect and
// Search Console drops it as "Page with redirect". That is what happened until
// November 2026; these pin the search middleware that stops it.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/blog.functions", () => ({ listPublishedBlogPosts: vi.fn() }));

const { Route } = await import("./index");

type Search = { page?: number };
type Middleware = (ctx: { search: Search; next: (s: Search) => Search }) => Search;
const middlewares = (Route.options as { search?: { middlewares?: Middleware[] } }).search
  ?.middlewares;

/** The address the router builds for a link or a redirect to these params. */
function built(search: Search): Search {
  return (middlewares ?? []).reduceRight<(s: Search) => Search>(
    (next, middleware) => (s) => middleware({ search: s, next }),
    (s) => s,
  )(search);
}

describe("/blog search params", () => {
  it("has a search middleware at all", () => {
    expect(middlewares?.length).toBeGreaterThan(0);
  });

  it("leaves page one out of the address", () => {
    expect(built({ page: 1 })).toEqual({});
  });

  it("keeps any later page in the address", () => {
    expect(built({ page: 2 })).toEqual({ page: 2 });
  });
});
