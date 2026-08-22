/**
 * What to put on screen when a fetch rejected.
 *
 * Every load path had its own `e instanceof Error ? e.message : "Failed to
 * load"`, which is fine until the thrown thing is a string, or an Error with an
 * empty message (TanStack's client throws `new Error(await response.text())`,
 * and an empty body makes an Error with nothing in it). Both of those printed a
 * sentence with a hole in it. This returns the caller's fallback instead.
 */
export function describeLoadError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message || fallback;
}
