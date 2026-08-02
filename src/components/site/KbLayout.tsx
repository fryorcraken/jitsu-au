// The knowledge base shell: its own top bar, its own sidebar, its own footer.
//
// Deliberately NOT `SiteLayout`. Everything else on the public site wears the
// marketing chrome, and the knowledge base is the one place where that chrome is
// working against the page: a member reading the syllabus does not need the ten
// marketing links across the top or a trial CTA underneath, and a sidebar bolted
// beneath a full site header reads as a page with navigation attached rather
// than a place you are in. One link back to the club site covers the case where
// somebody does want Pricing.
//
// Also NOT `components/ui/sidebar.tsx`, which `MemberLayout` uses: that one owns
// a `SidebarProvider` and a whole layout system, and the knowledge base needs a
// different top bar anyway. A sticky `<nav>` plus a `Sheet` on small screens is
// the whole requirement.
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, BookOpen, ExternalLink, Menu, Search, User, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import logoAsset from "@/assets/UTS_JITSU_CMYK.png.asset.json";
import { useAuth } from "@/hooks/useAuth";
import { useKbNav } from "@/hooks/useKbNav";
import type { KbNavSection } from "@/lib/kb-nav";
import { searchKnowledgeBase } from "@/lib/kb.functions";

export function KbLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { nav, loading } = useKbNav();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // Closing the drawer on navigation is the difference between the sidebar
  // being usable on a phone and it covering the article you just picked.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <button className="rounded-md p-2 lg:hidden" aria-label="Browse the knowledge base">
                <Menu className="h-5 w-5" />
              </button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[85vw] max-w-xs overflow-y-auto p-0">
              <SheetTitle className="border-b px-4 py-4 text-base">Knowledge base</SheetTitle>
              <div className="p-4">
                <KbNavList nav={nav} loading={loading} />
              </div>
            </SheetContent>
          </Sheet>

          <Link to="/kb" className="flex items-center gap-2.5">
            <img
              src={logoAsset.url}
              alt="UTS Jitsu logo"
              width={96}
              height={40}
              className="h-9 w-auto rounded bg-white p-1"
            />
            <span className="hidden text-sm font-semibold sm:inline">Knowledge base</span>
          </Link>

          <div className="ml-auto flex items-center gap-2">
            <KbSearch />
            <Button asChild size="sm" variant="ghost" className="max-md:hidden">
              <Link to="/">
                <ArrowLeft className="mr-1 h-4 w-4" />
                Back to the club site
              </Link>
            </Button>
            {user ? (
              <Button asChild size="sm" variant="ghost" className="max-sm:px-2">
                <Link to="/account">
                  <User className="h-4 w-4 sm:mr-1" />
                  <span className="max-sm:sr-only">Member space</span>
                </Link>
              </Button>
            ) : (
              <Button asChild size="sm" variant="ghost">
                <Link to="/auth">Sign in</Link>
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-8 px-4 py-8">
        <aside className="hidden w-60 shrink-0 lg:block">
          <div className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto pr-2">
            <KbNavList nav={nav} loading={loading} />
          </div>
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>

      {/* The same link is repeated here for the narrow screens where the top
          bar hides it for space, and it is the one place a reader who has just
          finished an article is already looking. */}
      <footer className="border-t">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <Link to="/" className="inline-flex items-center gap-1.5 hover:text-foreground md:hidden">
            <ArrowLeft className="h-4 w-4" />
            Back to the club site
          </Link>
          <span>© {new Date().getFullYear()} UTS Jitsu</span>
        </div>
      </footer>
    </div>
  );
}

/** The sidebar itself, shared by the desktop rail and the phone drawer. */
function KbNavList({ nav, loading }: { nav: KbNavSection[]; loading: boolean }) {
  const location = useLocation();

  // "There is nothing here" and "this has not arrived yet" are different
  // answers, and the sidebar used to give the first one for both. On a cold
  // load that flashed an empty-knowledge-base message next to a fully rendered
  // article, and on a failed nav fetch it stayed there.
  if (loading) return <p className="text-sm text-muted-foreground">Loading...</p>;

  if (!nav.length) {
    return (
      <p className="text-sm text-muted-foreground">There is nothing in the knowledge base yet.</p>
    );
  }

  return (
    <nav aria-label="Knowledge base" className="space-y-6">
      {nav.map((section) => (
        <div key={section.slug ?? "unsectioned"} className="space-y-1">
          <p className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {section.title}
          </p>
          <ul className="space-y-0.5">
            {section.entries.map((entry) => {
              const active = location.pathname === `/kb/${entry.slug}`;
              // A link entry leaves the knowledge base for the marketing site,
              // which is a different shell entirely — a plain anchor is the
              // honest thing to render, and it saves a client-side route that
              // would only bounce.
              const className = cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                active
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              );
              return (
                <li key={entry.slug}>
                  {entry.link_path ? (
                    <a href={entry.link_path} className={className}>
                      {entry.title}
                      <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
                    </a>
                  ) : (
                    <Link
                      to="/kb/$slug"
                      params={{ slug: entry.slug }}
                      className={className}
                      aria-current={active ? "page" : undefined}
                    >
                      {entry.title}
                      {/* Only a manager ever sees a managers-only entry, so
                          this marker is for them: which of these is still a
                          draft, without opening each one. */}
                      {entry.visibility === "managers" && (
                        <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          Draft
                        </span>
                      )}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * Search over article titles and text.
 *
 * Results appear under the box as you type, debounced, and the whole thing
 * collapses to an icon on a phone so the top bar keeps room for the logo.
 */
function KbSearch() {
  const { loading: authLoading } = useAuth();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const runSearch = useServerFn(searchKnowledgeBase);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 200);
    return () => clearTimeout(timer);
  }, [term]);

  // Clicking anywhere else puts the results away. Without this the panel stays
  // over the article until you happen to type again.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const query = useQuery({
    queryKey: ["kb-search", debounced],
    queryFn: () => runSearch({ data: { q: debounced } }),
    enabled: !authLoading && debounced.length >= 2,
  });

  const results = query.data ?? [];

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={term}
          onChange={(e) => {
            setTerm(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
          placeholder="Search"
          aria-label="Search the knowledge base"
          className="h-9 w-32 pl-8 sm:w-56"
        />
      </div>

      {open && debounced.length >= 2 && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border bg-background shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
            <span>
              {query.isLoading
                ? "Searching…"
                : `${results.length} result${results.length === 1 ? "" : "s"}`}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close search results"
              className="rounded p-0.5 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {results.length === 0 && !query.isLoading ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              Nothing matched “{debounced}”.
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto py-1">
              {results.map((result) => {
                const body = (
                  <>
                    <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                      <BookOpen className="h-3.5 w-3.5 shrink-0 opacity-60" />
                      {result.title}
                    </span>
                    {result.snippet && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {result.snippet}
                      </span>
                    )}
                  </>
                );
                return (
                  <li key={result.slug}>
                    {result.link_path ? (
                      <a href={result.link_path} className="block px-3 py-2 hover:bg-muted">
                        {body}
                      </a>
                    ) : (
                      <Link
                        to="/kb/$slug"
                        params={{ slug: result.slug }}
                        onClick={() => setOpen(false)}
                        className="block px-3 py-2 hover:bg-muted"
                      >
                        {body}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
