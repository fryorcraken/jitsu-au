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
