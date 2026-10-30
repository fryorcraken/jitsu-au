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
import type { SiteBanner } from "@/lib/validation";

/**
 * The banner to show, or null when it is off. A failed read is also null: the
 * banner is a notice, not something a visitor is waiting on, so the page simply
 * renders without it rather than with an error where the notice would be.
 */
export const getSiteBanner = createServerFn({ method: "GET" }).handler(
  async (): Promise<SiteBanner | null> => {
    const [{ supabaseAdmin }, { readSiteBanner }, { setResponseHeader }] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("@/lib/club-settings.server"),
      import("@tanstack/react-start/server"),
    ]);
    // Every public page asks for this, and it changes a few times a term. A
    // minute's caching (and a few more of serving the old copy while it
    // refreshes) keeps that from being a database read per page view, at the
    // cost of a change taking a minute or two to reach everybody.
    setResponseHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
    const read = await readSiteBanner(supabaseAdmin);
    if (!read.ok) {
      console.error("[site-banner] could not read the banner; rendering without it");
      return null;
    }
    return read.banner.enabled ? read.banner : null;
  },
);
