// These schemas decide what comes back off a device, so they have to describe
// what the server functions really return. A field the server starts sending
// that these do not know about must not invalidate every stored copy; a field
// whose meaning changed must be caught here rather than on somebody's phone.
import { describe, expect, it } from "vitest";
import {
  cacheReviver,
  kbArticleCacheSchema,
  kbNavCacheSchema,
  KB_CACHE_MAX_AGE_MS,
} from "@/lib/kb-cache";

const nav = {
  sections: [{ slug: "getting-started", title: "Getting started", position: 10 }],
  entries: [
    {
      slug: "your-first-class",
      title: "Your first class",
      link_path: null,
      section_slug: "getting-started",
      position: 10,
      visibility: "members",
      version: 3,
      read_version: 2,
      updated_at: "2026-08-01T00:00:00Z",
    },
    {
      slug: "pricing-link",
      title: "Pricing",
      link_path: "/pricing",
      section_slug: null,
      position: 20,
      visibility: "members",
      version: null,
      read_version: null,
      updated_at: "2026-08-01T00:00:00Z",
    },
  ],
};

const article = {
  redirect_to: null,
  article: {
    slug: "your-first-class",
    title: "Your first class",
    body_md: "## What to bring\n\nA water bottle.",
    version: 3,
    is_current_version: true,
    change_note: null,
    visibility: "members",
    annotations_enabled: true,
    nav_title: null,
    updated_at: "2026-08-01T00:00:00Z",
    sections: [
      { id: "what-to-bring", text: "What to bring", depth: 2, pinned: false, url: "/kb/x#y" },
    ],
  },
  viewer: { signed_in: true, user_id: "user-1", is_manager: false, can_annotate: true },
};

describe("kbNavCacheSchema", () => {
  it("accepts a real sidebar payload, articles and link entries alike", () => {
    expect(kbNavCacheSchema.safeParse(nav).success).toBe(true);
  });

  it("rejects one whose fields have changed type", () => {
    const broken = { ...nav, entries: [{ ...nav.entries[0], position: "10" }] };
    expect(kbNavCacheSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a visibility the app does not know", () => {
    // `public` does not exist for an article (docs/knowledge-base.md), and a
    // stored entry claiming one would be a permission level nothing enforces.
    const broken = { ...nav, entries: [{ ...nav.entries[0], visibility: "public" }] };
    expect(kbNavCacheSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects anything that is not the payload at all", () => {
    for (const value of [null, "text", 7, [], {}, { sections: [] }]) {
      expect(kbNavCacheSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("kbArticleCacheSchema", () => {
  it("accepts a real article payload", () => {
    expect(kbArticleCacheSchema.safeParse(article).success).toBe(true);
  });

  it("accepts the redirect a link entry returns, which has no article", () => {
    expect(
      kbArticleCacheSchema.safeParse({ redirect_to: "/pricing", article: null, viewer: null })
        .success,
    ).toBe(true);
  });

  it("rejects a payload missing the body", () => {
    const { body_md: _dropped, ...rest } = article.article;
    expect(kbArticleCacheSchema.safeParse({ ...article, article: rest }).success).toBe(false);
  });
});

describe("cacheReviver", () => {
  it("returns null rather than throwing on anything it cannot parse", () => {
    const revive = cacheReviver(kbNavCacheSchema);
    expect(revive(nav)).toEqual(nav);
    expect(revive(undefined)).toBeNull();
    expect(revive({ sections: "no" })).toBeNull();
  });
});

describe("KB_CACHE_MAX_AGE_MS", () => {
  it("is a week", () => {
    // Pinned because it is a judgement about how out of date the club's own
    // handbooks may be before showing them stops being a service.
    expect(KB_CACHE_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
