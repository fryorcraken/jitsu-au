// Putting the seeded club back the way the tour found it.
//
// Opening a screen is not read-only: /notifications marks the member's unread
// ones read, and a manager inbox stamps the club's "seen up to here" watermark
// (src/lib/seen-markers.ts). The tour walks every screen twice — once at
// desktop width, once at phone width — so without this the second pass would
// photograph a calmer club than the first, and the width most of this club
// browses at would be the one that never shows an unread badge.
//
// This is a KNOWN LIST, not a general undo. A new screen that marks something
// read when it opens has to be added here, or its unread state will only ever
// appear in the desktop gallery.

import { adminClient, readClubFixture } from "./fixture";

export async function restoreSeenState(): Promise<void> {
  const fixture = readClubFixture();
  const memberId = fixture.personas.member?.userId;
  const admin = adminClient();

  // /notifications marks everything unread read when it opens.
  if (memberId) {
    await admin
      .from("notifications")
      .update({ read_at: null })
      .eq("user_id", memberId)
      .eq("kind", "new_blog_post");
  }
  // The manager inboxes keep one club-wide watermark each; deleting it makes
  // the items unseen again.
  await admin
    .from("club_settings")
    .delete()
    .in("key", ["contact_messages_seen_at", "interest_registrations_seen_at"]);
}
