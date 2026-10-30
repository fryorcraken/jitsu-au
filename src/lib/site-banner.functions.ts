// The site banner as a visitor gets it: the one public read of `club_settings`.
//
// `club_settings` is manager-only under RLS and holds things no visitor may see
// (the bank account, the reply-to address, the managers' seen markers), so this
// does NOT open the table to `anon`. It reads one hardcoded key through the
// service role and returns only the parsed banner, which nothing the caller
// sends can widen: there is no input at all.
//
// ⚠️ Bundled to the client like every `*.functions.ts`, so the service-role
// client is only ever lazy-imported inside the handler.
import { createServerFn } from "@tanstack/react-start";
import { readDismissedSiteBanner, siteBannerFingerprint } from "@/lib/site-banner";
import type { SiteBanner } from "@/lib/validation";

/**
 * The banner to show this visitor, or null: when it is off, when they already
 * closed this one (the cookie in `site-banner.ts`), or when it could not be
 * read. A failed read is null rather than an error because the banner is a
 * notice, not something a visitor is waiting on, so the page simply renders
 * without it rather than with an error where the notice would be.
 *
 * No cache header, deliberately: the answer depends on the visitor's cookie,
 * and a manager who has just saved must see their change on the next page,
 * not one cached a minute ago. It is one primary-key read.
 */
export const getSiteBanner = createServerFn({ method: "GET" }).handler(
  async (): Promise<SiteBanner | null> => {
    const [{ supabaseAdmin }, { readSiteBanner }, { getRequestHeader }] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("@/lib/club-settings.server"),
      import("@tanstack/react-start/server"),
    ]);
    const read = await readSiteBanner(supabaseAdmin);
    if (!read.ok) {
      console.error("[site-banner] could not read the banner; rendering without it");
      return null;
    }
    if (!read.banner.enabled) return null;
    const dismissed = readDismissedSiteBanner(getRequestHeader("cookie"));
    return dismissed === siteBannerFingerprint(read.banner) ? null : read.banner;
  },
);
