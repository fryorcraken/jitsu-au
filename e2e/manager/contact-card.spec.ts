// A manager saves somebody's contact card from their person page, to put them
// in their phone. What goes on the card is proved in `src/lib/vcard.test.ts`;
// this is the part a unit test cannot see, that the button hands the browser a
// real `.vcf` file holding that person's details.

import { readFile } from "node:fs/promises";
import { expect, step, test } from "../support/test";
import { adminClient, readClubFixture } from "../support/fixture";

test("a manager downloads a member's contact card", async ({ page }) => {
  const { userId } = readClubFixture().personas.member;
  const { data: profile } = await adminClient()
    .from("profiles")
    .select("first_name, last_name, phone, address")
    .eq("user_id", userId)
    .single();
  if (!profile?.phone || !profile.address) throw new Error("the seeded member has no phone");

  await page.goto(`/manager/users/${userId}`);

  const download = await step(page, "downloads the member's contact card", async () => {
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download contact" }).click();
    return await pending;
  });

  expect(download.suggestedFilename()).toBe(`${profile.first_name} ${profile.last_name}.vcf`);
  const card = await readFile(await download.path(), "utf8");
  expect(card).toMatch(/^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
  expect(card).toContain(`N:${profile.last_name};${profile.first_name};;;`);
  expect(card).toContain(`TEL;TYPE=CELL:${profile.phone}`);
  // Commas are escaped on the card, so compare with them put back.
  expect(card.replace(/\r\n /g, "").replace(/\\,/g, ",")).toContain(profile.address);
});
