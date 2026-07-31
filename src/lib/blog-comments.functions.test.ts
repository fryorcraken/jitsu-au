// `insertBlogComment` and `toggleCommentUpvoteRow` are the pieces of
// blog-comments.functions.ts reachable from a unit test without a Start
// request context (the `createServerFn` handlers die on "No Start context
// found in AsyncLocalStorage" when called from the runner — see
// waiver.functions.test.ts). Both take their admin client as a parameter for
// exactly that reason.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { insertBlogComment, toggleCommentUpvoteRow } from "./blog-comments.functions";

type MaybeSingle<T> = { data: T | null; error: { message: string } | null };

function selectSingleBuilder<T>(resp: MaybeSingle<T>) {
  const b = {
    eq: () => b,
    maybeSingle: () => Promise.resolve(resp),
  };
  return b;
}

function fakeCommentAdmin(opts: {
  post?: MaybeSingle<{ id: string; status: string }>;
  blocked?: MaybeSingle<{ user_id: string }>;
  parent?: MaybeSingle<{ id: string; post_id: string; parent_comment_id: string | null }>;
  insertId?: string;
}) {
  const admin = {
    from(table: string) {
      if (table === "blog_posts") {
        return { select: () => selectSingleBuilder(opts.post ?? { data: null, error: null }) };
      }
      if (table === "blog_blocked_commenters") {
        return { select: () => selectSingleBuilder(opts.blocked ?? { data: null, error: null }) };
      }
      if (table === "blog_comments") {
        return {
          select: () => selectSingleBuilder(opts.parent ?? { data: null, error: null }),
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: opts.insertId ?? "new-comment" }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`fakeCommentAdmin: unexpected table ${table}`);
    },
  };
  return admin as unknown as SupabaseClient<Database>;
}

const POST_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const PARENT_ID = "33333333-3333-3333-3333-333333333333";

describe("insertBlogComment", () => {
  it("rejects a comment on a post that doesn't exist", async () => {
    const admin = fakeCommentAdmin({ post: { data: null, error: null } });
    await expect(
      insertBlogComment(admin, { postId: POST_ID, userId: USER_ID, body: "Hi" }),
    ).rejects.toThrow(/open for comments/);
  });

  it("rejects a comment on a draft post", async () => {
    const admin = fakeCommentAdmin({
      post: { data: { id: POST_ID, status: "draft" }, error: null },
    });
    await expect(
      insertBlogComment(admin, { postId: POST_ID, userId: USER_ID, body: "Hi" }),
    ).rejects.toThrow(/open for comments/);
  });

  it("rejects a comment from a blocked commenter", async () => {
    const admin = fakeCommentAdmin({
      post: { data: { id: POST_ID, status: "published" }, error: null },
      blocked: { data: { user_id: USER_ID }, error: null },
    });
    await expect(
      insertBlogComment(admin, { postId: POST_ID, userId: USER_ID, body: "Hi" }),
    ).rejects.toThrow(/not able to comment/);
  });

  it("rejects a reply whose parent is itself a reply", async () => {
    const admin = fakeCommentAdmin({
      post: { data: { id: POST_ID, status: "published" }, error: null },
      parent: {
        data: { id: PARENT_ID, post_id: POST_ID, parent_comment_id: "some-other-comment" },
        error: null,
      },
    });
    await expect(
      insertBlogComment(admin, {
        postId: POST_ID,
        userId: USER_ID,
        parentCommentId: PARENT_ID,
        body: "Hi",
      }),
    ).rejects.toThrow(/top-level comment/);
  });

  it("rejects a reply whose parent belongs to a different post", async () => {
    const admin = fakeCommentAdmin({
      post: { data: { id: POST_ID, status: "published" }, error: null },
      parent: {
        data: { id: PARENT_ID, post_id: "different-post", parent_comment_id: null },
        error: null,
      },
    });
    await expect(
      insertBlogComment(admin, {
        postId: POST_ID,
        userId: USER_ID,
        parentCommentId: PARENT_ID,
        body: "Hi",
      }),
    ).rejects.toThrow(/no longer exists/);
  });

  it("inserts a top-level comment on a published post", async () => {
    const admin = fakeCommentAdmin({
      post: { data: { id: POST_ID, status: "published" }, error: null },
      insertId: "comment-1",
    });
    await expect(
      insertBlogComment(admin, { postId: POST_ID, userId: USER_ID, body: "Great class!" }),
    ).resolves.toEqual({ id: "comment-1" });
  });

  it("inserts a reply to a top-level comment", async () => {
    const admin = fakeCommentAdmin({
      post: { data: { id: POST_ID, status: "published" }, error: null },
      parent: { data: { id: PARENT_ID, post_id: POST_ID, parent_comment_id: null }, error: null },
      insertId: "reply-1",
    });
    await expect(
      insertBlogComment(admin, {
        postId: POST_ID,
        userId: USER_ID,
        parentCommentId: PARENT_ID,
        body: "Agreed!",
      }),
    ).resolves.toEqual({ id: "reply-1" });
  });
});

/** A chainable, awaitable stub: `.eq()` returns itself so it survives any
 * number of chained filters, and `await`ing it at any point resolves to
 * `result` — matching how the real Postgrest builder works. */
function chainable<T>(result: T) {
  const obj: { eq: () => typeof obj; then: (resolve: (v: T) => void) => void } = {
    eq: () => obj,
    then: (resolve) => resolve(result),
  };
  return obj;
}

function fakeUpvoteAdmin(opts: { existing: boolean; count: number }) {
  const calls: string[] = [];
  const admin = {
    from(table: string) {
      if (table !== "blog_comment_upvotes")
        throw new Error(`fakeUpvoteAdmin: unexpected table ${table}`);
      return {
        select(_cols: string, options?: { count?: string; head?: boolean }) {
          if (options?.head) return chainable({ count: opts.count, error: null });
          const b = {
            eq: () => b,
            maybeSingle: () =>
              Promise.resolve({ data: opts.existing ? { user_id: "u1" } : null, error: null }),
          };
          return b;
        },
        insert: () => {
          calls.push("insert");
          return chainable({ error: null });
        },
        delete: () => {
          calls.push("delete");
          return chainable({ error: null });
        },
      };
    },
  };
  return { admin: admin as unknown as SupabaseClient<Database>, calls };
}

describe("toggleCommentUpvoteRow", () => {
  it("adds an upvote when none exists yet", async () => {
    const { admin, calls } = fakeUpvoteAdmin({ existing: false, count: 1 });
    await expect(toggleCommentUpvoteRow(admin, { commentId: "c1", userId: "u1" })).resolves.toEqual(
      { upvoted: true, count: 1 },
    );
    expect(calls).toEqual(["insert"]);
  });

  it("removes an existing upvote (toggle off)", async () => {
    const { admin, calls } = fakeUpvoteAdmin({ existing: true, count: 0 });
    await expect(toggleCommentUpvoteRow(admin, { commentId: "c1", userId: "u1" })).resolves.toEqual(
      { upvoted: false, count: 0 },
    );
    expect(calls).toEqual(["delete"]);
  });
});
