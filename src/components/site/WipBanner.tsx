import { AlertTriangle } from "lucide-react";

export const OFFICIAL_SITE_URL = "https://utsjitsu.com.au";

/**
 * Loud, permanent notice that this site is still being built, pointing visitors
 * at the club's official website. Rendered above everything else site-wide and
 * deliberately not dismissible: anyone who lands here by accident should not
 * mistake the unfinished site for the real one.
 */
export function WipBanner() {
  return (
    <div
      className="bg-destructive text-destructive-foreground"
      role="region"
      aria-label="Site notice"
    >
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-1 px-4 py-3 text-center sm:flex-row sm:justify-center sm:gap-3">
        <AlertTriangle className="h-6 w-6 shrink-0" aria-hidden="true" />
        <p className="text-base font-bold sm:text-lg">
          This site is a work in progress. The official UTS Jitsu website is{" "}
          <a href={OFFICIAL_SITE_URL} className="underline underline-offset-2 hover:no-underline">
            utsjitsu.com.au
          </a>
        </p>
      </div>
    </div>
  );
}
