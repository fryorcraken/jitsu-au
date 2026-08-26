// Remembering where the installed app was, so a relaunch can go back there.
//
// Storage only. The rule about whether to USE what is stored lives in `pwa.ts`
// (`resolveLaunchTarget`), free of browser globals so it can be unit tested; this
// is the half that touches the device.
//
// Recorded on every navigation, which is why it writes through `local-cache`
// rather than reaching for `localStorage` directly: it gets the owner scoping
// (so a manager's last screen is not restored for whoever signs in next), the
// clock-safe timestamp, and the never-throws guarantee for Safari's private
// mode, all of which this would otherwise have to repeat.

import { readCache, removeCache, writeCache } from "@/lib/local-cache";
import type { LastVisit } from "@/lib/pwa";

const KEY = "last-visit";
const VERSION = 1;

function revive(value: unknown): LastVisit | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<LastVisit>;
  if (typeof v.path !== "string" || !v.path) return null;
  if (typeof v.hasSession !== "boolean") return null;
  return { path: v.path, at: typeof v.at === "number" ? v.at : 0, hasSession: v.hasSession };
}

export function readLastVisit(owner: string | null): LastVisit | null {
  const hit = readCache<LastVisit>(KEY, { version: VERSION, owner, revive });
  // `at` comes off the envelope rather than the payload: the envelope is what
  // `local-cache` stamps, so it cannot drift from what was actually written.
  return hit ? { ...hit.data, at: hit.savedAt } : null;
}

export function writeLastVisit(owner: string | null, path: string, hasSession: boolean): void {
  writeCache(KEY, { path, at: 0, hasSession }, VERSION, owner);
}

export function clearLastVisit(): void {
  removeCache(KEY);
}
