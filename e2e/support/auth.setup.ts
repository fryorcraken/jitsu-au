// Sign each persona in once, and save the session for every test that needs it.
//
// This is the `setup` project in playwright.config.ts; the `member` and
// `manager` projects depend on it and start from the storage state it writes.

import { test as setup, expect } from "@playwright/test";

import { adminClient, readClubFixture, storageStatePath, type Persona } from "./fixture";

const PERSONAS: Persona[] = ["member", "manager"];

for (const persona of PERSONAS) {
  setup(`sign in as the ${persona}`, async ({ page, context, baseURL }) => {
    const fixture = readClubFixture();
    const email = fixture.personas[persona]?.email;
    expect(email, `the seeded club names no ${persona} to sign in as`).toBeTruthy();

    // Walk a real Supabase email link rather than writing a session into local
    // storage ourselves. The alternative means hard-coding the storage key the
    // generated client derives from the project URL, and would go stale
    // silently; this goes through the app's own landing path, so the session is
    // stored exactly the way a member's would be.
    //
    // The redirect target needs no configuration: GoTrue short-circuits its
    // allow-list check for a loopback address, so E2E_PORT can move on its own.
    const { data, error } = await adminClient().auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo: `${baseURL}/account` },
    });
    if (error) throw new Error(`could not make a sign-in link for ${email}: ${error.message}`);

    await page.goto(data.properties.action_link, { waitUntil: "networkidle" });

    // The link lands with tokens in the fragment and the client turns them into
    // a stored session a moment later. Waiting on the storage rather than on the
    // URL keeps this independent of where the app decides to send them.
    await page.waitForFunction(() =>
      Object.keys(localStorage).some((key) => key.endsWith("-auth-token")),
    );

    await context.storageState({ path: storageStatePath(persona) });
  });
}
