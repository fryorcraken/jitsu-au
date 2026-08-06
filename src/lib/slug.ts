// Slugs for blog posts: lowercase, hyphenated, URL-safe.

/**
 * Turn a title into a URL-safe slug: accents stripped, lowercased, anything
 * that isn't a letter or digit collapsed to a single hyphen, leading/trailing
 * hyphens trimmed. A title with no alphanumeric characters yields an empty
 * string — callers should treat that as "could not derive a slug" rather than
 * publish one.
 */
export function slugify(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Matches `blog_posts`' `char_length(slug) BETWEEN 1 AND 200` CHECK
 * constraint (`supabase/migrations/20260731100000_blog_posts.sql`). */
const BLOG_SLUG_MAX_LENGTH = 200;

/**
 * The default slug for a new blog post: today's date (`YYYY-MM-DD`) prefixed
 * onto the slugified title, so a post's URL reads chronologically even before
 * anyone sets a slug by hand. Empty when the title has no usable characters,
 * same as `slugify`, so callers can still treat that as "could not derive a
 * slug" rather than publish a bare date. The title alone can be as long as
 * the slug's own DB limit (both cap at 200), so the slugified title is
 * truncated to make room for the date prefix — otherwise a near-max-length
 * title would produce a slug the database rejects.
 */
export function defaultBlogSlug(title: string, now: Date = new Date()): string {
  const base = slugify(title);
  if (!base) return base;
  const prefix = `${now.toISOString().slice(0, 10)}-`;
  const truncatedBase = base.slice(0, BLOG_SLUG_MAX_LENGTH - prefix.length).replace(/-+$/g, "");
  return `${prefix}${truncatedBase}`;
}

/**
 * The first candidate slug (`base`, `base-2`, `base-3`, ...) not already in
 * `taken`. Pure so collision resolution is unit-testable without a database.
 */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
