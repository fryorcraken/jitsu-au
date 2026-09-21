import type { ReactNode } from "react";
import { OfferBanner } from "./OfferBanner";
import { SiteHeader } from "./SiteHeader";
import { SiteFooter } from "./SiteFooter";

export function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <OfferBanner />
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
