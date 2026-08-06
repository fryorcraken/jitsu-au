import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_DEFAULTS,
  badgeCount,
  blogCommentHref,
  blogPostHref,
  commentPreview,
  digestItemCount,
  digestSections,
  digestSubject,
  emailPreferenceKeys,
  hasDigestContent,
  kbAnnotationHref,
  notificationKinds,
  preferenceForKind,
  resolveNotificationPreference,
  resolveNotificationPreferences,
  shouldEmail,
  threadActivityRecipients,
  type NotificationItem,
  type NotificationKind,
} from "./notifications";
import type { ManagerNotification } from "./validation";

const ATTENTION: ManagerNotification = {
  type: "define_membership_window",
  title: "Set up the club's training dates",
  body: "Members cannot join as members until the club's training dates are set.",
  href: "/manager/membership-plans",
};

function item(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "reply",
    title: "Jane L. replied to you",
    body: "Nice one",
    href: "/blog/a-post#comment-1",
    read_at: null,
    created_at: "2026-08-06T00:00:00.000Z",
    ...over,
  };
}

describe("preferenceForKind", () => {
  it("maps every kind to a switch", () => {
    for (const kind of notificationKinds) {
      expect(emailPreferenceKeys).toContain(preferenceForKind[kind]);
    }
  });

  // Two kinds, one switch: "tell me about new comments" is one decision a
  // manager makes, not two. If this ever splits, the settings UI has to grow a
  // fourth row, so it is pinned rather than left to drift.
  it("puts both moderation kinds behind the same switch", () => {
    expect(preferenceForKind.blog_comment).toBe("manager_comment_alerts");
    expect(preferenceForKind.kb_comment).toBe("manager_comment_alerts");
  });
});

describe("NOTIFICATION_DEFAULTS", () => {
  // The product rule, not a tidiness check: announcements are the only kind
  // that would reach somebody who did nothing to ask for it, so they are the
  // only kind that defaults off.
  it("defaults announcements off and everything else on", () => {
    expect(NOTIFICATION_DEFAULTS.new_blog_post).toBe(false);
    expect(NOTIFICATION_DEFAULTS.reply_to_me).toBe(true);
    expect(NOTIFICATION_DEFAULTS.thread_activity).toBe(true);
    expect(NOTIFICATION_DEFAULTS.manager_comment_alerts).toBe(true);
  });
});

describe("resolveNotificationPreference", () => {
  it("falls back to the default when the switch was never chosen", () => {
    expect(resolveNotificationPreference({ reply_to_me: null }, "reply_to_me")).toBe(true);
    expect(resolveNotificationPreference({ new_blog_post: null }, "new_blog_post")).toBe(false);
  });

  it("falls back to the default when there is no row at all", () => {
    expect(resolveNotificationPreference(null, "reply_to_me")).toBe(true);
    expect(resolveNotificationPreference(undefined, "new_blog_post")).toBe(false);
  });

  // The reason the columns are nullable. `false` is a decision and must not be
  // overwritten by the default; if this ever collapsed to `stored || default`,
  // switching replies off would silently do nothing.
  it("keeps an explicit false distinct from an unset switch", () => {
    expect(resolveNotificationPreference({ reply_to_me: false }, "reply_to_me")).toBe(false);
    expect(resolveNotificationPreference({ reply_to_me: null }, "reply_to_me")).toBe(true);
  });

  it("keeps an explicit true on a switch that defaults off", () => {
    expect(resolveNotificationPreference({ new_blog_post: true }, "new_blog_post")).toBe(true);
  });
});

describe("resolveNotificationPreferences", () => {
  it("resolves every switch, mixing stored values and defaults", () => {
    expect(resolveNotificationPreferences({ new_blog_post: true, reply_to_me: false })).toEqual({
      reply_to_me: false,
      thread_activity: true,
      new_blog_post: true,
      manager_comment_alerts: true,
    });
  });

  it("returns the defaults for somebody with no row", () => {
    expect(resolveNotificationPreferences(null)).toEqual(NOTIFICATION_DEFAULTS);
  });
});

describe("shouldEmail", () => {
  it("follows the switch for a member kind", () => {
    expect(shouldEmail({ reply_to_me: false }, "reply")).toBe(false);
    expect(shouldEmail({ reply_to_me: true }, "reply")).toBe(true);
  });

  // A moderation alert reaching somebody who has lost the manager role would
  // leak comment traffic to a member, so the role is re-checked at send time
  // rather than trusted from whenever the preference row was written.
  it("never emails a moderation alert to a non-manager, whatever the switch says", () => {
    expect(shouldEmail({ manager_comment_alerts: true }, "blog_comment")).toBe(false);
    expect(shouldEmail({ manager_comment_alerts: true }, "kb_comment")).toBe(false);
    expect(shouldEmail({ manager_comment_alerts: true }, "blog_comment", { isManager: true })).toBe(
      true,
    );
  });

  it("lets a manager switch moderation alerts off", () => {
    expect(shouldEmail({ manager_comment_alerts: false }, "kb_comment", { isManager: true })).toBe(
      false,
    );
  });

  it("keeps announcements off for somebody who never opted in", () => {
    expect(shouldEmail(null, "new_blog_post")).toBe(false);
    expect(shouldEmail({ new_blog_post: true }, "new_blog_post")).toBe(true);
  });
});

describe("badgeCount", () => {
  it("counts unread activity", () => {
    expect(badgeCount([], [item(), item({ read_at: "2026-08-06T01:00:00.000Z" })])).toBe(1);
  });

  // Attention items have no read state, so they can only leave the badge by
  // being fixed. A badge that went quiet while the club had no sellable
  // training dates would be worse than no badge.
  it("counts attention items even though they can never be read", () => {
    expect(badgeCount([ATTENTION], [item({ read_at: "2026-08-06T01:00:00.000Z" })])).toBe(1);
    expect(badgeCount([ATTENTION], [item()])).toBe(2);
  });

  it("is zero when everything is read and nothing needs attention", () => {
    expect(badgeCount([], [item({ read_at: "2026-08-06T01:00:00.000Z" })])).toBe(0);
    expect(badgeCount([], [])).toBe(0);
  });
});

describe("digestSections", () => {
  const rows = [
    item({ kind: "reply" }),
    item({ kind: "thread_activity" }),
    item({ kind: "new_blog_post" }),
    item({ kind: "blog_comment" }),
    item({ kind: "kb_comment" }),
  ];

  it("groups the kinds a person wants into their sections", () => {
    const sections = digestSections(rows, { new_blog_post: true }, { isManager: true });
    expect(sections.replies).toHaveLength(1);
    expect(sections.threads).toHaveLength(1);
    expect(sections.posts).toHaveLength(1);
    // Both moderation kinds land in one section, matching the single switch.
    expect(sections.moderation).toHaveLength(2);
  });

  it("drops the kinds a person has switched off", () => {
    const sections = digestSections(rows, { thread_activity: false, new_blog_post: false });
    expect(sections.threads).toHaveLength(0);
    expect(sections.posts).toHaveLength(0);
    expect(sections.replies).toHaveLength(1);
  });

  it("gives a member no moderation section", () => {
    expect(digestSections(rows, null).moderation).toHaveLength(0);
  });

  it("leaves a person with everything off nothing to send", () => {
    const sections = digestSections(rows, {
      reply_to_me: false,
      thread_activity: false,
      new_blog_post: false,
      manager_comment_alerts: false,
    });
    expect(hasDigestContent(sections)).toBe(false);
  });
});

describe("hasDigestContent", () => {
  it("is false for an empty digest, so no email goes out", () => {
    expect(hasDigestContent({ replies: [], threads: [], posts: [], moderation: [] })).toBe(false);
  });

  it("is true when any one section has something", () => {
    expect(hasDigestContent({ replies: [], threads: [], posts: [item()], moderation: [] })).toBe(
      true,
    );
  });
});

describe("digestItemCount and digestSubject", () => {
  it("counts across every section", () => {
    expect(
      digestItemCount({ replies: [item()], threads: [item()], posts: [], moderation: [item()] }),
    ).toBe(3);
  });

  it("says one thing in the singular", () => {
    const subject = digestSubject("UTS Jitsu", {
      replies: [item()],
      threads: [],
      posts: [],
      moderation: [],
    });
    expect(subject).toBe("1 new thing at UTS Jitsu");
  });

  it("counts in the plural", () => {
    const subject = digestSubject("UTS Jitsu", {
      replies: [item(), item()],
      threads: [],
      posts: [],
      moderation: [],
    });
    expect(subject).toBe("2 new things at UTS Jitsu");
  });

  // Copy rule from AGENTS.md: no em dashes in anything a person reads, and a
  // subject line is the most-read copy the club writes.
  it("uses no em dash", () => {
    const subject = digestSubject("UTS Jitsu", {
      replies: [item()],
      threads: [],
      posts: [],
      moderation: [],
    });
    expect(subject).not.toContain("—");
  });
});

describe("threadActivityRecipients", () => {
  it("never tells you about your own comment", () => {
    expect(threadActivityRecipients(["a", "b", "c"], { actorId: "b" })).toEqual(["a", "c"]);
  });

  // Without this the parent's author gets an instant reply email AND a line in
  // their digest about the same words.
  it("skips the person already getting a direct reply notification", () => {
    expect(
      threadActivityRecipients(["a", "b", "c"], { actorId: "b", directReplyToId: "a" }),
    ).toEqual(["c"]);
  });

  it("de-duplicates somebody who commented several times", () => {
    expect(threadActivityRecipients(["a", "a", "b"], { actorId: "b" })).toEqual(["a"]);
  });

  it("returns nobody when the writer is the only participant", () => {
    expect(threadActivityRecipients(["a"], { actorId: "a" })).toEqual([]);
  });
});

describe("hrefs", () => {
  it("anchors a blog comment on its post", () => {
    expect(blogCommentHref("2026-08-06-a-post", "c1")).toBe("/blog/2026-08-06-a-post#comment-c1");
  });

  it("anchors a knowledge base comment on its article", () => {
    expect(kbAnnotationHref("grading", "a1")).toBe("/kb/grading#comment-a1");
  });

  it("points a post announcement at the post", () => {
    expect(blogPostHref("a-post")).toBe("/blog/a-post");
  });

  // The DB CHECK requires `href LIKE '/%'`: these are site-relative because the
  // email sender prefixes the origin, and a stored absolute URL would bake the
  // host into rows that outlive it.
  it("builds site-relative paths", () => {
    expect(blogCommentHref("s", "c").startsWith("/")).toBe(true);
    expect(kbAnnotationHref("s", "a").startsWith("/")).toBe(true);
    expect(blogPostHref("s").startsWith("/")).toBe(true);
  });
});

describe("commentPreview", () => {
  it("leaves a short comment alone", () => {
    expect(commentPreview("Great class tonight")).toBe("Great class tonight");
  });

  it("collapses newlines and runs of whitespace", () => {
    expect(commentPreview("Great\n\n  class   tonight")).toBe("Great class tonight");
  });

  it("cuts at a word boundary and marks the cut", () => {
    const preview = commentPreview("alpha bravo charlie delta", 13);
    expect(preview).toBe("alpha bravo...");
  });

  it("stays within the limit plus the ellipsis", () => {
    const preview = commentPreview("x".repeat(400));
    expect(preview.length).toBeLessThanOrEqual(163);
  });

  it("handles a single word longer than the limit", () => {
    expect(commentPreview("y".repeat(20), 5)).toBe("yyyyy...");
  });
});
