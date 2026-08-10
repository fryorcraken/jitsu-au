// The seeded local club the end-to-end tests run against, and the guard that
// keeps them off the hosted project.
//
// The manifest is written by scripts/seed-local-club.mjs — the same seed the PR
// screenshots use, so there is one description of "a club with people in it"
// rather than two that drift. docs/e2e-tests.md has the run instructions.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type Persona = "member" | "manager";

type ClubFixture = {
  /** Which database these ids exist in. Checked against SUPABASE_URL below. */
  supabaseUrl?: string;
  personas: Record<Persona, { email: string; userId: string }>;
  password: string;
  params: Record<string, string>;
};

const FIXTURE_PATH = resolve(process.env.LOCAL_CLUB_FIXTURE ?? ".local-club-fixture.json");
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Where a persona's signed-in session is saved. Mirrors playwright.config.ts. */
export function storageStatePath(persona: Persona) {
  return `e2e/.auth/${persona}.json`;
}

/**
 * The seeded club, or a hard failure explaining which half of the setup is
 * missing.
 *
 * Deliberately not a smaller run: a manifest without credentials (or the
 * reverse) means a step got reordered or an environment variable stopped being
 * exported, and quietly skipping every signed-in flow would take the whole
 * suite's point away behind a green check.
 */
export function readClubFixture(): ClubFixture {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `No seeded club at ${FIXTURE_PATH}. Run \`bash scripts/e2e.sh\`, or see docs/e2e-tests.md.`,
    );
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error(
      `There is a seeded club at ${FIXTURE_PATH} but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set, so nobody can be signed in.`,
    );
  }

  // Signing in is a SERVICE-ROLE admin call, and GoTrue's generate_link CREATES
  // the account when it does not exist — so pointed at the hosted project this
  // would put fixture people in the club's real auth. Checking the manifest's
  // own URL as well as the loopback rule catches the case where the two arrive
  // from different places (bun auto-loads `.env`, so it happens).
  assertLocalSupabase(SUPABASE_URL);
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ClubFixture;
  if (fixture.supabaseUrl && fixture.supabaseUrl !== SUPABASE_URL) {
    throw new Error(
      `The club was seeded against ${fixture.supabaseUrl} but SUPABASE_URL is ${SUPABASE_URL}. Refusing to sign in: these are different databases.`,
    );
  }
  return fixture;
}

/** Refuse to make admin calls against anything but a local stack. */
export function assertLocalSupabase(url: string) {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `Refusing to talk to ${host} as the service role: the end-to-end tests only ever drive a local stack.`,
    );
  }
}

/**
 * A service-role client for arranging and inspecting fixture state.
 *
 * Use it to set a test up or to check what a flow wrote, never to stand in for
 * the flow itself — a test that writes the row the app was supposed to write
 * passes whether or not the app works.
 */
export function adminClient(): SupabaseClient {
  const url = SUPABASE_URL;
  if (!url || !SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.");
  }
  assertLocalSupabase(url);
  return createClient(url, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
