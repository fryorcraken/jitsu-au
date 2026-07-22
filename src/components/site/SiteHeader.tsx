import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Menu, X, User, CreditCard, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import logoAsset from "@/assets/UTS_JITSU_CMYK.png.asset.json";
import { useAuth } from "@/hooks/useAuth";

const nav = [
  { to: "/", label: "Home" },
  { to: "/about", label: "About" },
  { to: "/instructors", label: "Instructors" },
  { to: "/classes", label: "Classes" },
  { to: "/first-class", label: "First class" },
  { to: "/pricing", label: "Pricing" },
  { to: "/faq", label: "FAQ" },
  { to: "/contact", label: "Contact" },
] as const;

const memberSpaceNav = [
  { to: "/account", label: "Account", icon: User },
  { to: "/membership", label: "Membership", icon: CreditCard },
] as const;

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2">
          <img
            src={logoAsset.url}
            alt="UTS Jitsu logo"
            width={96}
            height={40}
            className="h-10 w-auto rounded bg-white p-1"
          />
        </Link>
        <nav className="hidden items-center gap-6 md:flex">
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              activeProps={{ className: "text-foreground" }}
              activeOptions={{ exact: n.to === "/" }}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  <User className="mr-1 h-4 w-4" />
                  Member space
                  <ChevronDown className="ml-1 h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {memberSpaceNav.map((n) => (
                  <DropdownMenuItem key={n.to} asChild>
                    <Link to={n.to}>
                      <n.icon className="mr-2 h-4 w-4" />
                      {n.label}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button asChild size="sm" variant="ghost">
              <Link to="/auth">Member login</Link>
            </Button>
          )}
          <Button asChild size="sm">
            <Link to="/register-interest">Start your free trial</Link>
          </Button>
        </div>
        <button
          className="rounded-md p-2 md:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle menu"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>
      <div className={cn("border-t md:hidden", open ? "block" : "hidden")}>
        <nav className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3">
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              activeProps={{ className: "bg-muted text-foreground" }}
              activeOptions={{ exact: n.to === "/" }}
              onClick={() => setOpen(false)}
            >
              {n.label}
            </Link>
          ))}
          {user ? (
            <>
              <div className="px-3 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Member space
              </div>
              {memberSpaceNav.map((n) => (
                <Link
                  key={n.to}
                  to={n.to}
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => setOpen(false)}
                >
                  <n.icon className="h-4 w-4" />
                  {n.label}
                </Link>
              ))}
            </>
          ) : (
            <Link
              to="/auth"
              className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setOpen(false)}
            >
              Member login
            </Link>
          )}
          <Button asChild size="sm" className="mt-2">
            <Link to="/register-interest" onClick={() => setOpen(false)}>
              Start your free trial
            </Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}
