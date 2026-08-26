// What the knowledge base is allowed to keep on the device, and how it is read
// back.
//
// `usePersistentQuery` needs a `revive` that is TOTAL: it parses data written by
// a previous build of the site, possibly mangled, possibly typed in by hand, and
// it runs during a render. A cast would turn leftover storage into a white
// screen on launch, which is a worse failure than the spinner this removes.
//
// So the shapes are declared with Zod, the same seam every form in this app
// already validates through (`src/lib/validation.ts`), rather than a second
// hand-rolled set of type guards. `safeParse` IS the total function the cache
// wants, and declaring the shape once means a server function that changes what
// it returns fails a test here instead of silently poisoning every device.
//
// `.catch(...)` on the soft fields and `.passthrough()` are deliberate: a field
// ADDED to one of these payloads must not invalidate every stored copy, or a
// deploy would empty the cache it exists to fill. A field whose TYPE changed is
// a different matter, and bumping `KB_CACHE_VERSION` is how that is handled.

import { z } from "zod";
import { articleVisibilities } from "./kb";

/**
 * Bumped when a stored payload's meaning changes in a way `safeParse` would not
 * catch — a renamed field, a repurposed one. Adding a field does not need it.
 */
export const KB_CACHE_VERSION = 1;

/**
 * How long a stored copy of the knowledge base is worth showing.
 *
 * A week. These are the club's own handbooks and policies; they change a few
 * times a year, and a member on the mat reading last week's copy of the grading
 * syllabus is being served well, not misled. The background refresh replaces it
 * within a second of the page opening anyway — this bound is about the case
 * where there is no network at all.
 */
export const KB_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

const visibility = z.enum(articleVisibilities);

const navSection = z.object({
  slug: z.string(),
  title: z.string(),
  position: z.number(),
});

const navEntry = z.object({
  slug: z.string(),
  title: z.string(),
  link_path: z.string().nullable(),
  section_slug: z.string().nullable(),
  position: z.number(),
  visibility,
  version: z.number().nullable(),
  read_version: z.number().nullable(),
  updated_at: z.string().nullable(),
});

export const kbNavCacheSchema = z.object({
  sections: z.array(navSection),
  entries: z.array(navEntry),
});

const articleHeading = z.object({
  id: z.string(),
  text: z.string(),
  depth: z.number(),
  pinned: z.boolean(),
  url: z.string(),
});

export const kbArticleCacheSchema = z.object({
  redirect_to: z.string().nullable(),
  article: z
    .object({
      slug: z.string(),
      title: z.string(),
      body_md: z.string(),
      version: z.number(),
      is_current_version: z.boolean(),
      change_note: z.string().nullable(),
      visibility,
      annotations_enabled: z.boolean(),
      nav_title: z.string().nullable(),
      updated_at: z.string().nullable(),
      sections: z.array(articleHeading),
    })
    .nullable(),
  viewer: z
    .object({
      signed_in: z.boolean(),
      user_id: z.string().nullable(),
      is_manager: z.boolean(),
      can_annotate: z.boolean(),
    })
    .nullable(),
});

/**
 * Turn a schema into the `revive` the cache wants.
 *
 * The cast at the end is the one place this is unavoidable and it is safe: the
 * server function's return type is what was written, the schema describes it,
 * and `schema.test.ts` is what keeps the two honest. Everything reaching a
 * component has been through `safeParse`, so nothing unparsed is ever rendered.
 */
export function cacheReviver<T>(schema: z.ZodType): (value: unknown) => T | null {
  return (value) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? (parsed.data as T) : null;
  };
}
