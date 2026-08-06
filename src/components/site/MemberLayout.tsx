import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  BookOpen,
  CalendarDays,
  ChevronLeft,
  ClipboardCheck,
  CreditCard,
  FileText,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Newspaper,
  ScrollText,
  Settings,
  User,
  Users,
  Wallet,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, useRoles } from "@/hooks/useAuth";
import logoAsset from "@/assets/UTS_JITSU_CMYK.png.asset.json";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar";

type NavItem = { to: string; label: string; icon: typeof User };

const memberNav: NavItem[] = [
  // First: what a new member is meant to read before anything else. The rest of
  // this group is admin they only visit when something needs doing.
  { to: "/kb", label: "Knowledge base", icon: BookOpen },
  { to: "/account", label: "Account", icon: User },
  { to: "/membership", label: "Membership", icon: CreditCard },
];

const managerNav: NavItem[] = [
  // First: the manager's home — where they land and where the attention queue lives.
  { to: "/manager", label: "Dashboard", icon: LayoutDashboard },
  // Then: the highest-frequency manager screen, used at the door every class.
  { to: "/manager/check-in", label: "Check in", icon: ClipboardCheck },
  { to: "/manager/users", label: "Users", icon: Users },
  { to: "/manager/memberships", label: "Memberships", icon: CreditCard },
  { to: "/manager/membership-plans", label: "Membership plans", icon: ScrollText },
  { to: "/manager/waivers", label: "Signed waivers", icon: FileText },
  { to: "/manager/waiver-template", label: "Waiver template", icon: FileText },
  // "editor" in the label because the member group above already has a
  // "Knowledge base" entry pointing at the reader. Same content, two jobs.
  { to: "/manager/kb", label: "Knowledge base editor", icon: BookOpen },
  { to: "/manager/blog", label: "Blog posts", icon: Newspaper },
  { to: "/manager/blog-comments", label: "Blog comments", icon: MessageSquare },
  { to: "/manager/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/manager/reconciliation", label: "Bank reconciliation", icon: Wallet },
  { to: "/manager/settings", label: "Club settings", icon: Settings },
  { to: "/manager/api-tokens", label: "Agent access", icon: KeyRound },
];

function isActivePath(pathname: string, to: string) {
  // The dashboard is every manager page's prefix, so prefix matching would
  // light it up on all of them. It is active on its own path only.
  if (to === "/manager") return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}

function NavList({ items, pathname }: { items: NavItem[]; pathname: string }) {
  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.to}>
          <SidebarMenuButton
            asChild
            isActive={isActivePath(pathname, item.to)}
            tooltip={item.label}
          >
            <Link to={item.to}>
              <item.icon />
              <span>{item.label}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

export function MemberLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user } = useAuth();
  const { isManager } = useRoles(user?.id);

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth" });
  }

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <img
              src={logoAsset.url}
              alt="UTS Jitsu logo"
              width={36}
              height={36}
              className="h-9 w-9 shrink-0 rounded bg-white p-1"
            />
            <div className="flex flex-col group-data-[collapsible=icon]:hidden">
              <span className="text-sm font-black leading-tight">UTS Jitsu</span>
              <span className="text-xs text-sidebar-foreground/70">Member space</span>
            </div>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Back to site">
                <Link to="/">
                  <ChevronLeft />
                  <span>Back to site</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Your account</SidebarGroupLabel>
            <NavList items={memberNav} pathname={pathname} />
          </SidebarGroup>

          {isManager && (
            <SidebarGroup>
              <SidebarGroupLabel>Manager</SidebarGroupLabel>
              <NavList items={managerNav} pathname={pathname} />
            </SidebarGroup>
          )}
        </SidebarContent>

        <SidebarFooter>
          <SidebarSeparator />
          {user?.email && (
            <div className="truncate px-2 py-1 text-xs text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden">
              {user.email}
            </div>
          )}
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={signOut} tooltip="Sign out">
                <LogOut />
                <span>Sign out</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>

        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <span className="text-sm font-semibold">Member space</span>
        </header>
        <div className="flex-1">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
