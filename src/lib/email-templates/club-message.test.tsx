import * as React from "react";
import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";

import { ClubMessageEmail } from "./club-message";

const PROPS = {
  siteName: "UTS Jitsu",
  siteUrl: "https://utsjitsu.com.au",
  greeting: "Sam",
  subject: "Dojo closed on 24 December",
  body: "The dojo is **closed** on 24 December.\n\n- Thursday runs as usual\n\nSee [the calendar](https://utsjitsu.com.au/calendar).",
  audience: "person" as const,
  replyTo: "committee@example.com",
};

const visibleText = (html: string) =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

async function html(props: Partial<React.ComponentProps<typeof ClubMessageEmail>> = {}) {
  return render(React.createElement(ClubMessageEmail, { ...PROPS, ...props }));
}

describe("ClubMessageEmail", () => {
  it("renders the manager's formatting as email markup", async () => {
    const out = await html();
    expect(out).toContain("<strong>closed</strong>");
    expect(out).toContain('href="https://utsjitsu.com.au/calendar"');
    expect(visibleText(out)).toContain("Thursday runs as usual");
  });

  it("never renders raw HTML a manager typed in", async () => {
    const out = await html({ body: 'Hello <img src="https://tracker.test/x.png"> there' });
    expect(out).not.toContain("<img");
    expect(out).not.toContain("tracker.test");
    expect(visibleText(out)).toContain("Hello there");
  });

  it("shows a picture link as its words only, fetching nothing", async () => {
    const out = await html({ body: "![the new mats](https://images.test/mats.jpg)" });
    expect(out).not.toContain("images.test");
    expect(visibleText(out)).toContain("the new mats");
  });

  it("tells a member it is a club notice about training", async () => {
    expect(visibleText(await html())).toContain(
      "This is a club notice from UTS Jitsu about training.",
    );
  });

  it("tells a lead why they are getting it", async () => {
    expect(visibleText(await html({ audience: "lead" }))).toContain(
      "You're getting this because you asked about training at UTS Jitsu.",
    );
  });

  it("names the child for a parent", async () => {
    expect(visibleText(await html({ forWhom: "Bea" }))).toContain("Hi Sam, this is about Bea.");
  });

  it("marks a test copy as one", async () => {
    expect(visibleText(await html({ test: true }))).toContain("Test copy, sent only to you.");
    expect(visibleText(await html())).not.toContain("Test copy");
  });

  it("offers a reply only when one reaches somebody", async () => {
    expect(visibleText(await html())).toContain("Just reply to this email.");
    expect(visibleText(await html({ replyTo: null }))).not.toContain("Just reply");
  });

  it("uses no em dash", async () => {
    expect(visibleText(await html({ audience: "lead", test: true }))).not.toContain("—");
  });
});
