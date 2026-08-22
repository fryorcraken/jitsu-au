import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { Toaster } from "sonner";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { SOCIAL_IMAGE } from "../lib/seo";
import { setUpServiceWorker } from "../lib/service-worker";

// `data-page-state` marks a page that rendered a boundary instead of itself.
// The end-to-end tour (e2e/tour/site.spec.ts) treats its presence as a
// failed page: both boundaries are served with an ordinary 200, so a status
// code alone cannot tell a rendered page from a broken one.
function NotFoundComponent() {
  return (
    <div
      data-page-state="not-found"
      className="flex min-h-screen items-center justify-center bg-background px-4"
    >
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div
      data-page-state="error"
      className="flex min-h-screen items-center justify-center bg-background px-4"
    >
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "UTS Jitsu | Practical Japanese Jiu-Jitsu in Sydney" },
      {
        name: "description",
        content:
          "Learn practical self-defence at UTS Ultimo. Beginner-friendly Japanese Jiu-Jitsu classes Mon, Wed & Sat. First two sessions free.",
      },
      { property: "og:site_name", content: "UTS Jitsu" },
      { property: "og:type", content: "website" },
      // Installed-app chrome: the address bar / status bar tint, and the name
      // and title style iOS uses for a home-screen launch.
      { name: "theme-color", content: "#008eaa" },
      { name: "application-name", content: "UTS Jitsu" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "UTS Jitsu" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { property: "og:url", content: "https://jitsu.au/" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:title", content: "UTS Jitsu | Practical Japanese Jiu-Jitsu in Sydney" },
      { name: "twitter:title", content: "UTS Jitsu | Practical Japanese Jiu-Jitsu in Sydney" },
      {
        property: "og:description",
        content:
          "Learn practical self-defence at UTS Ultimo. Beginner-friendly Japanese Jiu-Jitsu classes Mon, Wed & Sat. First two sessions free.",
      },
      {
        name: "twitter:description",
        content:
          "Learn practical self-defence at UTS Ultimo. Beginner-friendly Japanese Jiu-Jitsu classes Mon, Wed & Sat. First two sessions free.",
      },
      // Set once here so every page has a share image. Child routes override
      // the title/description/url around it, not the picture.
      { property: "og:image", content: SOCIAL_IMAGE.url },
      { property: "og:image:width", content: String(SOCIAL_IMAGE.width) },
      { property: "og:image:height", content: String(SOCIAL_IMAGE.height) },
      { property: "og:image:alt", content: SOCIAL_IMAGE.alt },
      { name: "twitter:image", content: SOCIAL_IMAGE.url },
      { name: "twitter:image:alt", content: SOCIAL_IMAGE.alt },
    ],
    links: [
      // No canonical here. Unlike meta tags, TanStack Router does not replace a
      // parent's <link> when a child declares the same rel: it appends. A
      // site-wide canonical therefore shipped a second, competing
      // <link rel="canonical" href="https://jitsu.au/"> on every subpage, and a
      // page with two canonicals has none as far as a search engine is
      // concerned. Each public page sets its own; noindex pages need none.
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png", sizes: "180x180" },
      // The typeface is served from this origin (see the @font-face rules in
      // src/styles.css), so there is no third party to preconnect to and no
      // cross-origin stylesheet to fetch before the font files are discovered.
      // Preloading the latin file starts it with the stylesheet rather than
      // after it. `crossOrigin` is required even same-origin: a font fetch is
      // always CORS, and without it the browser downloads the file twice.
      //
      // latin-ext is deliberately not preloaded. Most pages contain no
      // character that needs it, and the browser skips the file entirely on
      // those; preloading would make every visitor pay for it.
      {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        href: "/fonts/nunito-sans-latin.woff2",
        crossOrigin: "anonymous",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

// Captured at module load, before anything touches the Supabase client: an
// email link lands with its tokens in the URL fragment, and Supabase clears
// them from the address bar the moment it initialises.
const initialHref = typeof window === "undefined" ? "" : window.location.href;

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  useEffect(() => setUpServiceWorker(), []);

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | undefined;
    import("@/lib/auth-persistence").then(({ applyRememberPreference }) => {
      if (mounted) applyRememberPreference(initialHref);
    });
    import("@/integrations/supabase/client").then(({ supabase }) => {
      const { data: sub } = supabase.auth.onAuthStateChange((event) => {
        if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
        router.invalidate();
        if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
      });
      // The import resolves asynchronously, so the effect may already have been
      // cleaned up by the time we get here.
      if (!mounted) sub.subscription.unsubscribe();
      else unsubscribe = () => sub.subscription.unsubscribe();
    });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [queryClient, router]);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
      <Toaster richColors position="top-center" />
    </QueryClientProvider>
  );
}
