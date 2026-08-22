// The typeface is served from this origin, and has to stay that way.
//
// Loading it from Google's CDN disclosed every visitor's IP and user agent to
// Google before they had interacted with anything, on the public marketing
// pages, so it applied to people who had not signed up to anything. Putting the
// files in public/ fixed that, but nothing stops the next person adding a
// `<link href="https://fonts.googleapis.com/...">` back: it is one line, it
// looks ordinary, and the page renders identically either way. Nobody would
// notice until someone read the network tab.
//
// So this asserts the absence, not the presence, and it checks the whole of
// src/ rather than the one file the link used to live in.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if ([".ts", ".tsx", ".css", ".html"].includes(extname(entry))) out.push(full);
  }
  return out;
}

describe("the typeface is self-hosted", () => {
  it("never reaches for a Google font host anywhere in src/", () => {
    const offenders = sourceFiles(join(root, "src"))
      .filter((file) => !file.endsWith("fonts.test.ts"))
      .filter((file) => /fonts\.(googleapis|gstatic)\.com/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(root.length + 1));

    expect(offenders, "load the font from public/fonts instead").toEqual([]);
  });

  it("serves every file the stylesheet asks for", () => {
    const css = readFileSync(join(root, "src/styles.css"), "utf8");
    const referenced = [...css.matchAll(/url\("(\/fonts\/[^"]+)"\)/g)].map((m) => m[1]);

    // A typo in one of these paths is silent: @font-face fails, the fallback
    // stack takes over, and every page renders in the system font instead.
    expect(referenced.length).toBeGreaterThan(0);
    for (const href of referenced) {
      expect(existsSync(join(root, "public", href)), `missing ${href}`).toBe(true);
    }
  });

  it("keeps a real fallback stack, so a failed fetch is not invisible text", () => {
    const css = readFileSync(join(root, "src/styles.css"), "utf8");
    for (const token of ["--font-sans:", "--font-display:"]) {
      const line = css.split("\n").find((l) => l.includes(token));
      expect(line, `${token} not found`).toBeTruthy();
      expect(line, `${token} needs a non-Nunito fallback`).toMatch(/sans-serif/);
    }
  });

  it("ships the licence next to the files, as the OFL requires", () => {
    const licence = readFileSync(join(root, "public/fonts/OFL.txt"), "utf8");
    expect(licence).toContain("SIL Open Font License");
    expect(licence).toContain("Nunito Sans Project Authors");
  });
});
