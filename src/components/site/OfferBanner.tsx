import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  isOfferBannerDismissed,
  isOfferBannerHiddenPath,
  persistOfferBannerDismissed,
} from "@/lib/offer-banner";

/**
 * Slim, dismissible top banner. While the club trains at a temporary location
 * free trials are paused, so it says so up front (before anybody turns up
 * expecting a free class) and points them at registering their interest, so
 * they hear when trials reopen. Rendered site-wide above the header; dismissal
 * persists via localStorage.
 */
export function OfferBanner() {
  // Start hidden so the server render and first client render agree
  // (localStorage is client-only). Reveal after mount unless it was dismissed.
  const [visible, setVisible] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (!isOfferBannerDismissed(window.localStorage)) setVisible(true);
  }, []);

  if (isOfferBannerHiddenPath(pathname) || !visible) return null;

  const dismiss = () => {
    persistOfferBannerDismissed(window.localStorage);
    setVisible(false);
  };

  return (
    <div className="bg-primary text-primary-foreground">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-1.5 text-sm">
        <Link
          to="/register-interest"
          className="flex flex-1 items-center justify-center gap-1.5 text-center font-medium hover:underline"
        >
          <span aria-hidden="true">📍</span>
          <span>
            We're training at a temporary location, so free trials are paused for now.{" "}
            <span className="underline underline-offset-2">
              Register your interest and we'll tell you when they reopen
            </span>
          </span>
        </Link>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss notice"
          className="shrink-0 rounded p-1 opacity-80 transition hover:bg-white/15 hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
