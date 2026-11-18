// Page one of the blog is `/blog`, never `/blog?page=1`. The sitemap lists
// `/blog` and the page names it as its canonical, so if the router writes the
// default page back into the address, `/blog` is answered with a redirect and
// Search Console drops it as "Page with redirect". That is what happened until
// November 2026.
//
// These run the real router over this route's own search options, rather than
// a model of how its middlewares compose, so a router upgrade that changes that
// is caught here.
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

vi.mock("@/lib/blog.functions", () => ({ listPublishedBlogPosts: vi.fn() }));

const { Route } = await import("./index");

/** A router holding just /blog, configured exactly as the app's route is. */
function blogRouter(url: string) {
  const rootRoute = createRootRoute();
  const blogRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/blog",
    validateSearch: Route.options.validateSearch,
    search: Route.options.search,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([blogRoute]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
}

/** The address the router writes for a link to /blog with these params. */
function linkHref(search: { page: number }): string {
  return blogRouter("/blog").buildLocation({ to: "/blog", search }).href;
}

describe("/blog addresses", () => {
  it("writes a link to page one as plain /blog", () => {
    expect(linkHref({ page: 1 })).toBe("/blog");
  });

  it("keeps the page number for every later page", () => {
    expect(linkHref({ page: 2 })).toBe("/blog?page=2");
  });

  it("settles an old ?page=1 link on /blog", async () => {
    const router = blogRouter("/blog?page=1");
    await router.load();
    const { href } = router.buildLocation({
      to: "/blog",
      search: router.state.location.search,
    });
    expect(href).toBe("/blog");
  });
});

describe("/blog canonical, page by page", () => {
  type Head = (ctx: unknown) => { links: { rel: string; href: string }[]; meta: unknown[] };
  const head = Route.options.head as unknown as Head;

  /** The canonical the head gives page `page` of a list with `total` updates. */
  function canonicalFor(page: number, total: number): string {
    const result = { total, pageSize: 10, posts: [], articles: [], articleCount: 0, page };
    const { links } = head({ match: { search: { page } }, loaderData: { result, error: false } });
    return links.find((l) => l.rel === "canonical")!.href;
  }

  it("names /blog for page one", () => {
    expect(canonicalFor(1, 25)).toBe("https://utsjitsu.com.au/blog");
  });

  it("names a later page itself, not page one", () => {
    expect(canonicalFor(3, 25)).toBe("https://utsjitsu.com.au/blog?page=3");
  });

  it("points a page past the end at /blog, so an empty page is never offered", () => {
    expect(canonicalFor(4, 25)).toBe("https://utsjitsu.com.au/blog");
  });
});
