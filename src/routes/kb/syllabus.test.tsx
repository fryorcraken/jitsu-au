// The member's syllabus by topic. The rules about WHAT it contains (which belts,
// which topics, what is skipped) are pinned in `syllabus.test.ts`; these pin the
// screen: that each state has something on it a person can act on, and that the
// belt and topic pickers drive the address, so the view can be shared.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { SyllabusData } from "@/lib/syllabus";

const mockUseSyllabus = vi.fn();
const navigate = vi.fn();
let search: { up_to?: string; topic?: string } = {};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useSearch: () => search,
    fullPath: "/kb/syllabus",
  }),
  useNavigate: () => navigate,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/hooks/useSyllabus", () => ({ useSyllabus: () => mockUseSyllabus() }));
// The knowledge base's link renders a preview card with its own queries; the
// page only needs ordinary markdown here.
vi.mock("@/lib/kb-markdown", () => ({ kbMarkdownComponents: {}, kbRemarkPlugins: [] }));

const { Route } = await import("./syllabus");
const SyllabusPage = (Route as unknown as { component: () => ReactNode }).component;

const belt = (slug: string, name: string, position: number, visibility = "members") => ({
  slug,
  name,
  grade: null,
  colour: "#000000",
  position,
  page_slug: `${slug}-belt`,
  visibility: visibility as "members" | "managers",
});

const DATA: SyllabusData & { viewer: { signed_in: boolean; is_manager: boolean } } = {
  belts: [belt("yellow", "Yellow", 20), belt("orange", "Orange", 30), belt("green", "Green", 40)],
  topics: [
    { slug: "breakfalling", title: "Breakfalling", parent: null, position: 10 },
    { slug: "techniques", title: "Techniques", parent: null, position: 20 },
    { slug: "throws", title: "Throws", parent: "techniques", position: 10 },
  ],
  entries: [
    { belt: "yellow", topic: "breakfalling", body_md: "Peg leg" },
    { belt: "green", topic: "breakfalling", body_md: "Judo rolls" },
    { belt: "orange", topic: "throws", body_md: "O Goshi" },
  ],
  viewer: { signed_in: true, is_manager: false },
};

const ready = (data = DATA) => ({
  data,
  loading: false,
  error: null,
  refetch: vi.fn(),
  restoredAt: null,
});

describe("/kb/syllabus", () => {
  beforeEach(() => {
    search = {};
  });
  afterEach(() => {
    mockUseSyllabus.mockReset();
    navigate.mockReset();
    vi.restoreAllMocks();
  });

  it("shows every topic up to the most senior belt by default, skipping empty belts", () => {
    // jsdom lays nothing out, so every heading reports a top of 0, as if all
    // had been scrolled past. Put them below the fold, as on a fresh load.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      top: 600,
    } as DOMRect);
    mockUseSyllabus.mockReturnValue(ready());
    render(<SyllabusPage />);

    const breakfalling = screen.getByRole("region", { name: "Breakfalling" });
    expect(within(breakfalling).getByText("Peg leg")).toBeInTheDocument();
    expect(within(breakfalling).getByText("Judo rolls")).toBeInTheDocument();
    // Orange has nothing on breakfalling, so it has no block under it.
    expect(within(breakfalling).getByRole("article", { name: "Yellow belt" })).toBeInTheDocument();
    expect(within(breakfalling).queryByRole("article", { name: "Orange belt" })).toBeNull();
    // The topic row, with the first topic marked as the one being read.
    const topics = screen.getByRole("navigation", { name: "Topics" });
    expect(within(topics).getByRole("link", { name: "Breakfalling" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(within(topics).getByRole("link", { name: "Techniques" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("stops at the belt in the address", () => {
    search = { up_to: "orange" };
    mockUseSyllabus.mockReturnValue(ready());
    render(<SyllabusPage />);

    expect(screen.getByText("Peg leg")).toBeInTheDocument();
    expect(screen.queryByText("Judo rolls")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Up to")).toHaveValue("orange");
  });

  it("puts the chosen belt and topic in the address, so the view can be shared", async () => {
    mockUseSyllabus.mockReturnValue(ready());
    render(<SyllabusPage />);

    await userEvent.selectOptions(screen.getByLabelText("Up to"), "orange");
    await userEvent.selectOptions(screen.getByLabelText("Topic"), "throws");
    const updates = navigate.mock.calls.map(([arg]) => arg.search({}));
    expect(updates).toEqual([{ up_to: "orange" }, { topic: "throws" }]);
    expect(navigate.mock.calls.every(([arg]) => arg.replace === true)).toBe(true);
  });

  it("says so when a shared link names a belt the syllabus does not have", () => {
    search = { up_to: "blue" };
    mockUseSyllabus.mockReturnValue(ready());
    render(<SyllabusPage />);

    expect(screen.getByRole("status")).toHaveTextContent(/belt called .blue./);
    expect(screen.getByText("Judo rolls")).toBeInTheDocument();
  });

  it("keeps a failed load on screen with a retry", async () => {
    const refetch = vi.fn();
    mockUseSyllabus.mockReturnValue({
      data: null,
      loading: false,
      error: "Failed to fetch",
      refetch,
      restoredAt: null,
    });
    render(<SyllabusPage />);

    expect(screen.getByRole("alert")).toHaveTextContent("The syllabus could not be loaded.");
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("says the syllabus is not published yet, rather than showing an empty page", () => {
    mockUseSyllabus.mockReturnValue(ready({ ...DATA, belts: [], entries: [] }));
    render(<SyllabusPage />);
    expect(screen.getByText(/has not been published yet/)).toBeInTheDocument();
  });

  it("announces the wait", () => {
    mockUseSyllabus.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refetch: vi.fn(),
      restoredAt: null,
    });
    render(<SyllabusPage />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("marks a belt that is still a draft, for the manager who can see it", () => {
    mockUseSyllabus.mockReturnValue(
      ready({
        ...DATA,
        belts: [...DATA.belts.slice(0, 2), belt("green", "Green", 40, "managers")],
      }),
    );
    render(<SyllabusPage />);
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });
});
