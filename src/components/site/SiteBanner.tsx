import { Link, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getSiteBanner } from "@/lib/site-banner.functions";
import {
  SITE_BANNER_QUERY_KEY,
  isSiteBannerLinkToHere,
  persistDismissedSiteBanner,
  readDismissedSiteBanner,
  siteBannerFingerprint,
} from "@/lib/site-banner";
import type { SiteBanner as SiteBannerValue } from "@/lib/validation";

/**
 * The slim, dismissible notice above the header on every public page. A
 * manager writes it and turns it on or off at `/manager/site-banner`; when it
 * is off, or could not be read, nothing renders at all.
 *
 * Client-only on purpose: whether this visitor closed it lives in localStorage,
 * so the server render and the first client render both show nothing and the
 * banner appears once both answers are in.
 */
export function SiteBanner() {
  const fetchBanner = useServerFn(getSiteBanner);
  const { data: banner } = useQuery({
    queryKey: SITE_BANNER_QUERY_KEY,
    queryFn: () => fetchBanner(),
    // One read per visit is plenty for a notice that changes a few times a term.
    staleTime: 5 * 60_000,
  });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // undefined until mounted, so nothing renders before localStorage is read.
  const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setDismissed(readDismissedSiteBanner(window.localStorage));
  }, []);

  if (!banner || dismissed === undefined) return null;
  const fingerprint = siteBannerFingerprint(banner);
  if (dismissed === fingerprint) return null;

  const dismiss = () => {
    persistDismissedSiteBanner(window.localStorage, fingerprint);
    setDismissed(fingerprint);
  };

  return <SiteBannerBar banner={banner} pathname={pathname} onDismiss={dismiss} />;
}

/**
 * The bar itself, for the live banner and for the manager screen's preview.
 * Without `onDismiss` it is a preview: nothing in it is clickable, so trying
 * the link cannot navigate a manager away from a form they have not saved.
 */
export function SiteBannerBar({
  banner,
  pathname,
  onDismiss,
}: {
  banner: SiteBannerValue;
  pathname: string;
  onDismiss?: () => void;
}) {
  return (
    <div className="bg-primary text-primary-foreground">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-1.5 text-sm">
        <BannerText banner={banner} pathname={pathname} interactive={Boolean(onDismiss)} />
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss notice"
            className="shrink-0 rounded p-1 opacity-80 transition hover:bg-white/15 hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        ) : (
          <X className="h-4 w-4 shrink-0 opacity-80" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

/**
 * The message, and its link when it has one. The whole line is the link rather
 * than only the link text: it is a thumb-sized target on a phone.
 */
function BannerText({
  banner,
  pathname,
  interactive,
}: {
  banner: SiteBannerValue;
  pathname: string;
  interactive: boolean;
}) {
  const className = "flex-1 text-center font-medium";
  const linked = banner.link_href && !isSiteBannerLinkToHere(banner.link_href, pathname);
  if (!linked) return <p className={className}>{banner.message}</p>;

  const content = (
    <>
      {banner.message} <span className="underline underline-offset-2">{banner.link_label}</span>
    </>
  );
  if (!interactive) return <p className={className}>{content}</p>;
  if (banner.link_href.startsWith("/")) {
    return (
      <Link to={banner.link_href} className={`${className} hover:underline`}>
        {content}
      </Link>
    );
  }
  return (
    <a href={banner.link_href} rel="noopener noreferrer" className={`${className} hover:underline`}>
      {content}
    </a>
  );
}
