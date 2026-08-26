// The one place this app writes something to the device on purpose.
//
// Three separate problems needed the same small thing — a value, kept between
// page loads, that must never crash a page load and must never outlive the
// person it belongs to:
//
//   * an unsaved draft somebody is part-way through typing (`editor-draft.ts`),
//   * an answer worth painting immediately on the next launch instead of a
//     spinner (`use-persistent-query.ts`),
//   * where the installed app was when the phone took it away (`pwa.ts`).
//
// Rather than three hand-rolled `try { JSON.parse(localStorage...) }` blocks
// this is the seam, and it enforces the three rules that make storage on a
// device safe to rely on:
//
//   1. **Versioned.** A value written by an older build of the site is discarded
//      rather than half-read. A renamed field that restores as `undefined` is
//      worse than no restore at all, because nobody can see what went missing.
//   2. **Owned.** Every entry records who it was written for. A different person
//      signing in on the same device reads nothing, and signing out can wipe
//      everything belonging to that person in one call. This is what keeps one
//      member's data off the next member's screen on a shared club laptop.
//   3. **Dated.** Every entry records when it was written, so a caller can
//      refuse one that is too old to be trustworthy and can tell somebody how
//      old the thing they are looking at is.
//
// Deliberately free of React, of server imports and of side effects at module
// scope, so the pure half is unit-testable without a DOM — the same shape as
// `auth-persistence.ts` and `waiver-draft.ts`.

/** Everything under this app's control on the device shares this prefix. */
export const LOCAL_CACHE_PREFIX = "uts-jitsu.cache.";

/** What actually goes into storage. Short keys: it is written on a keystroke. */
type Envelope = {
  /** Schema version of the *payload*, chosen by the caller. */
  v: number;
  /** When it was written, epoch ms. */
  at: number;
  /** The user id it belongs to, or null for "signed out / belongs to nobody". */
  o: string | null;
  d: unknown;
};

export type CacheHit<T> = {
  data: T;
  /** Epoch ms. What to show when telling somebody how old this is. */
  savedAt: number;
};

export type CacheTerms<T> = {
  /** Bump when the payload's shape changes. Older entries are then ignored. */
  version: number;
  /** Who the entry belongs to. A mismatch reads as a miss. */
  owner: string | null;
  /** Refuse an entry older than this. Omit to accept any age. */
  maxAgeMs?: number;
  /**
   * Coerce whatever was stored into `T`, or return null to reject it.
   *
   * Required, and required to be total: this parses data that a previous build
   * of the site wrote, that a browser extension may have mangled, or that
   * somebody typed into devtools. Trusting it with a cast is how leftover
   * storage takes a page down on load.
   */
  revive: (value: unknown) => T | null;
};

/* ---------------- The pure half ---------------- */

/** Wrap a payload for storage. Exported for tests; callers use `writeCache`. */
export function packCache(
  data: unknown,
  version: number,
  owner: string | null,
  now: number,
): string {
  return JSON.stringify({ v: version, at: now, o: owner, d: data } satisfies Envelope);
}

/**
 * Read a stored string back, or null if it is not a usable entry.
 *
 * Never throws. The caller is always a page load or a render, and a page that
 * will not start because of something left in storage is a worse failure than
 * the one this is trying to prevent.
 */
export function unpackCache<T>(
  raw: string | null,
  terms: CacheTerms<T>,
  now: number,
): CacheHit<T> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const envelope = parsed as Partial<Envelope>;
  if (envelope.v !== terms.version) return null;
  if (typeof envelope.at !== "number" || !Number.isFinite(envelope.at)) return null;
  const owner = envelope.o === undefined ? null : envelope.o;
  if (owner !== terms.owner) return null;
  // A clock that moved backwards (a phone correcting itself, a timezone change
  // on a device that keeps local time) would otherwise make a fresh entry look
  // like one from the future and, with `maxAgeMs`, hide it forever.
  const age = Math.max(0, now - envelope.at);
  if (terms.maxAgeMs !== undefined && age > terms.maxAgeMs) return null;
  const data = terms.revive(envelope.d);
  if (data === null) return null;
  return { data, savedAt: envelope.at };
}

/* ---------------- The storage half ---------------- */

/**
 * `localStorage`, or null when there isn't one.
 *
 * Not only an SSR guard: Safari in private browsing and locked-down enterprise
 * profiles throw on the property access itself rather than returning null.
 */
export function localCacheStore(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function fullKey(key: string): string {
  return `${LOCAL_CACHE_PREFIX}${key}`;
}

export function readCache<T>(
  key: string,
  terms: CacheTerms<T>,
  now = Date.now(),
): CacheHit<T> | null {
  const store = localCacheStore();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(fullKey(key));
  } catch {
    return null;
  }
  const hit = unpackCache(raw, terms, now);
  // A rejected entry is never coming back — wrong version, wrong owner, or past
  // its age. Drop it now rather than leaving it to sit against the quota until
  // something else needs the room.
  if (!hit && raw !== null) removeCache(key);
  return hit;
}

export function writeCache(
  key: string,
  data: unknown,
  version: number,
  owner: string | null,
  now = Date.now(),
): void {
  const store = localCacheStore();
  if (!store) return;
  try {
    store.setItem(fullKey(key), packCache(data, version, owner, now));
  } catch {
    // Out of quota, or storage refused. Everything still works; it just will not
    // survive the page going away. Never surface this: there is nothing the
    // person on the other end could do about it.
  }
}

export function removeCache(key: string): void {
  const store = localCacheStore();
  if (!store) return;
  try {
    store.removeItem(fullKey(key));
  } catch {
    /* nothing to do */
  }
}

/**
 * Drop every entry belonging to `owner` (or every entry at all, when `owner` is
 * undefined).
 *
 * This is what sign-out calls. It reads each entry's envelope rather than
 * guessing from the key, so an entry can be keyed however its caller likes and
 * still be cleaned up correctly.
 */
export function clearCacheFor(owner?: string | null): void {
  const store = localCacheStore();
  if (!store) return;
  let keys: string[];
  try {
    keys = Object.keys(store).filter((key) => key.startsWith(LOCAL_CACHE_PREFIX));
  } catch {
    return;
  }
  for (const key of keys) {
    try {
      if (owner !== undefined) {
        const parsed = JSON.parse(store.getItem(key) ?? "null") as Partial<Envelope> | null;
        // An unreadable entry has no owner we can trust, so treat it as ours to
        // remove: leaving it would mean it can never be cleaned up at all.
        if (parsed && typeof parsed === "object" && (parsed.o ?? null) !== owner) continue;
      }
      store.removeItem(key);
    } catch {
      /* skip whatever we cannot read or remove */
    }
  }
}
