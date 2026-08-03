import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KbNavSection } from "@/lib/kb-nav";

const mockUseKbNav = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params?: { slug?: string };
    children: React.ReactNode;
  }) => (
    <a href={params?.slug ? to.replace("$slug", params.slug) : to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: "/kb" }),
}));

vi.mock("@/hooks/useKbNav", () => ({ useKbNav: () => mockUseKbNav() }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" }, loading: false }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: [], isLoading: false }) }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: () => vi.fn() }));
vi.mock("@/lib/kb.functions", () => ({ searchKnowledgeBase: vi.fn() }));
vi.mock("@/assets/UTS_JITSU_CMYK.png.asset.json", () => ({ default: { url: "logo.png" } }));

import { KbLayout } from "./KbLayout";

/** One section, so the sidebar has something to render around. */
function navWith(entries: KbNavSection["entries"]): KbNavSection[] {
  return [{ slug: "start-here", title: "Start here", entries }];
}

const article = (over: Partial<KbNavSection["entries"][number]> & { slug: string }) => ({
  title: over.slug,
  link_path: null,
  section_slug: "start-here",
  section_title: "Start here",
  position: 10,
  href: `/kb/${over.slug}`,
  ...over,
});

describe("KbLayout sidebar", () => {
  afterEach(() => mockUseKbNav.mockReset());

  // Asked for directly: the knowledge base is reached from the member area, so
  // the way back has to be in the sidebar, which is the only navigation on
  // screen at all on a phone.
  it("links back to the member space", () => {
    mockUseKbNav.mockReturnValue({
      nav: navWith([article({ slug: "first-belt" })]),
      loading: false,
    });
    render(<KbLayout>article</KbLayout>);

    const links = screen.getAllByRole("link", { name: /back to member space/i });
    expect(links.length).toBeGreaterThanOrEqual(1);
    for (const link of links) expect(link).toHaveAttribute("href", "/account");
  });

  // The way out must not depend on a fetch landing. Both of these states used
  // to render a bare sentence with no navigation whatsoever.
  it("keeps that link while the knowledge base is still loading, and when it is empty", () => {
    for (const state of [
      { nav: [], loading: true },
      { nav: [], loading: false },
    ]) {
      mockUseKbNav.mockReturnValue(state);
      const { unmount } = render(<KbLayout>article</KbLayout>);
      expect(screen.getAllByRole("link", { name: /back to member space/i }).length).toBeGreaterThan(
        0,
      );
      unmount();
    }
  });

  it("ticks off an article this member has read, and flags one rewritten since", () => {
    mockUseKbNav.mockReturnValue({
      nav: navWith([
        article({ slug: "read-it", version: 2, read_version: 2 }),
        article({ slug: "changed", version: 3, read_version: 2, position: 20 }),
        article({ slug: "not-yet", version: 1, read_version: null, position: 30 }),
      ]),
      loading: false,
    });
    render(<KbLayout>article</KbLayout>);

    const nav = screen.getByRole("navigation", { name: "Knowledge base" });
    const items = within(nav).getAllByRole("listitem");
    expect(within(items[0]).getByLabelText("Read")).toBeInTheDocument();
    expect(within(items[1]).getByText("Updated since you read it")).toBeInTheDocument();
    expect(within(items[2]).queryByLabelText("Read")).not.toBeInTheDocument();
  });

  // Nothing here reports on anyone else, and the sidebar is where that would
  // show first: a link entry has no page in the knowledge base to have read.
  it("never marks a link entry as read", () => {
    mockUseKbNav.mockReturnValue({
      nav: navWith([article({ slug: "faq", link_path: "/faq", read_version: 4 })]),
      loading: false,
    });
    render(<KbLayout>article</KbLayout>);
    expect(screen.queryByLabelText("Read")).not.toBeInTheDocument();
  });
});
