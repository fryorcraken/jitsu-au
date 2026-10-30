import { useLoaderData, useRouter, useRouterState } from "@tanstack/react-router";
import { useState, type MouseEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import {
  dismissSiteBannerCookie,
  shouldDropSiteBannerLink,
  siteBannerFingerprint,
  siteBannerLocalHref,
  siteBannerNavigatesInApp,
} from "@/lib/site-banner";
import type { SiteBanner as SiteBannerValue } from "@/lib/validation";

/**
 * The slim, dismissible notice above the header on every public page. A
 * manager writes it and turns it on or off at `/manager/site-banner`; when it
 * is off, closed, or could not be read, nothing renders at all.
 *
 * The root route's loader reads it, so the server draws it into the page and
 * nothing moves when the page loads. That read already leaves out a banner
 * this visitor closed (the cookie travels with it), so this renders exactly
 * what the loader says and never reads the cookie itself: doing that while
 * drawing could disagree with the server's HTML. Closing it refreshes the
 * loader, so the next page asks the server again and gets nothing.
 */
export function SiteBanner() {
  const { siteBanner: banner } = useLoaderData({ from: "__root__" });
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Set when closed on this page, so it goes at once.
  const [closed, setClosed] = useState<string | null>(null);

  if (!banner) return null;
  const fingerprint = siteBannerFingerprint(banner);
  if (closed === fingerprint) return null;

  const dismiss = () => {
    document.cookie = dismissSiteBannerCookie(fingerprint, window.location.protocol === "https:");
    setClosed(fingerprint);
    void router.invalidate({ filter: (match) => match.routeId === "__root__" });
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
  const linked = banner.link_href && !shouldDropSiteBannerLink(banner.link_href, pathname);
  if (!linked) return <p className={className}>{banner.message}</p>;

  const content = (
    <>
      {banner.message}{" "}
      <span className="underline underline-offset-2 group-hover/banner:decoration-2 group-focus-visible/banner:decoration-2">
        {banner.link_label}
      </span>
    </>
  );
  if (!interactive) return <p className={className}>{content}</p>;
  return (
    // One underline only: the link text's own. A hover underline on the whole
    // line drew a second, offset line under the link text. Hover and keyboard
    // focus instead darken the line (the close button's own cue, darker so the
    // white text keeps its contrast) and thicken the link text's underline.
    // The group is named so only this link drives that, never some ancestor.
    <BannerLink
      href={banner.link_href}
      className={`${className} group/banner rounded px-1 transition hover:bg-black/10 focus-visible:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground`}
    >
      {content}
    </BannerLink>
  );
}

/**
 * The link. A real anchor either way, so it can be opened in a new tab and read
 * by a screen reader as a link. For a page on this site a plain click is handed
 * to the router instead, so it is an in-app move rather than a reload of the
 * whole app on a phone's connection. The router's own <Link> is not used
 * because its `to` is a route path, and a manager's `/faq#trial` is a URL.
 */
function BannerLink({
  href,
  className,
  children,
}: {
  href: string;
  className: string;
  children: ReactNode;
}) {
  const local = siteBannerLocalHref(href);
  if (local && siteBannerNavigatesInApp(local)) {
    return (
      <LocalBannerLink href={local} className={className}>
        {children}
      </LocalBannerLink>
    );
  }
  return (
    <a href={local ?? href} rel={local ? undefined : "noreferrer"} className={className}>
      {children}
    </a>
  );
}

function LocalBannerLink({
  href,
  className,
  children,
}: {
  href: string;
  className: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // A modified click (new tab, new window) is the browser's, not ours.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    void router.navigate({ href });
  };
  return (
    <a href={href} onClick={onClick} className={className}>
      {children}
    </a>
  );
}
