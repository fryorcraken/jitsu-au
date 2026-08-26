// Check-in is run at the door of a university gym, on a phone, by a manager with
// a queue of people in front of them. These pin the two things that decide
// whether it is usable there: the roster is on screen when there is no signal,
// and the manager is told when what they are reading is not live.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { CHECKIN_CACHE_MAX_AGE_MS } from "@/lib/checkin-cache";
import { PERSISTENT_QUERY_VERSION } from "@/hooks/use-persistent-query";
import { writeCache } from "@/lib/local-cache";

const listCheckInEvents = vi.fn();
const getCheckInBoard = vi.fn();
const listUncoveredCheckIns = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "manager-1" }, session: null, loading: false }),
  useRoles: () => ({ roles: ["manager"], loading: false, isManager: true }),
}));
vi.mock("@/lib/checkin.functions", () => ({
  listCheckInEvents: (...a: unknown[]) => listCheckInEvents(...a),
  getCheckInBoard: (...a: unknown[]) => getCheckInBoard(...a),
  listUncoveredCheckIns: (...a: unknown[]) => listUncoveredCheckIns(...a),
  checkInPerson: vi.fn(),
  undoCheckIn: vi.fn(),
  attachCheckInCoverage: vi.fn(),
}));

const { Route } = await import("./manager.check-in");
const CheckInPage = (Route as unknown as { component: () => ReactNode }).component;

const EVENT = {
  id: "event-1",
  title: "Beginners",
  instructor_name: "Sam",
  location: "UTS Ultimo",
  // Far enough out that `pickDefaultEvent` has an obvious answer whatever the
  // clock says when this runs.
  starts_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  ends_at: new Date(Date.now() + 150 * 60_000).toISOString(),
  status: "scheduled",
};

const BOARD = {
  event: EVENT,
  roster: [
    {
      user_id: "user-1",
      name: "Jane L.",
      email: "jane@example.com",
      coverage: "period",
      plan_name: "Semester",
      sessions_remaining_before: null,
      consumes_credit: false,
      warnings: [],
    },
  ],
  checkins: [
    {
      id: "checkin-1",
      user_id: "user-1",
      name: "Jane L.",
      checked_in_at: new Date().toISOString(),
      coverage: "period",
      plan_name: "Semester",
      consumed_credit: false,
      warnings: [],
    },
  ],
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CheckInPage />
    </QueryClientProvider>,
  );
}

/** Put a class list and a roster on the device, as a previous visit would have. */
function seedDevice(savedAt: number) {
  writeCache(
    "checkin-events.manager-1",
    [{ ...EVENT, checked_in_count: 1 }],
    PERSISTENT_QUERY_VERSION,
    "manager-1",
    savedAt,
  );
  writeCache(
    "checkin-board.manager-1.event-1",
    BOARD,
    PERSISTENT_QUERY_VERSION,
    "manager-1",
    savedAt,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  listUncoveredCheckIns.mockResolvedValue([]);
});

describe("/manager/check-in offline", () => {
  it("shows the roster from the device when the network is gone", async () => {
    seedDevice(Date.now() - 60_000);
    listCheckInEvents.mockRejectedValue(new Error("Failed to fetch"));
    getCheckInBoard.mockRejectedValue(new Error("Failed to fetch"));

    renderPage();

    // The person on the mat is listed, even though every request failed.
    expect(await screen.findByText("Jane L.")).toBeInTheDocument();
    // And the failure is NOT dressed up as an empty room.
    expect(screen.queryByText("Nobody yet.")).not.toBeInTheDocument();
  });

  it("says so, rather than passing the stored roster off as live", async () => {
    seedDevice(Date.now() - 60_000);
    listCheckInEvents.mockRejectedValue(new Error("Failed to fetch"));
    getCheckInBoard.mockRejectedValue(new Error("Failed to fetch"));

    renderPage();

    const notice = await screen.findByText(/saved on this device/i);
    expect(notice).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("says nothing about staleness once the refresh lands", async () => {
    seedDevice(Date.now() - 60_000);
    listCheckInEvents.mockResolvedValue([{ ...EVENT, checked_in_count: 1 }]);
    getCheckInBoard.mockResolvedValue(BOARD);

    renderPage();

    expect(await screen.findByText("Jane L.")).toBeInTheDocument();
    await waitFor(() => expect(getCheckInBoard).toHaveBeenCalled());
    expect(screen.queryByText(/saved on this device/i)).not.toBeInTheDocument();
  });

  it("does not use a roster older than a day", async () => {
    seedDevice(Date.now() - CHECKIN_CACHE_MAX_AGE_MS - 1);
    listCheckInEvents.mockRejectedValue(new Error("Failed to fetch"));
    getCheckInBoard.mockRejectedValue(new Error("Failed to fetch"));

    renderPage();

    // Memberships are raised and waivers signed between classes, so a roster
    // this old is a wrong answer rather than a convenience. The screen falls
    // back to saying it could not load, which is honest.
    await waitFor(() =>
      expect(screen.getByText(/The class list could not be loaded/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText("Jane L.")).not.toBeInTheDocument();
  });

  it("does not hand one manager's roster to a different manager", async () => {
    writeCache(
      "checkin-board.manager-1.event-1",
      BOARD,
      PERSISTENT_QUERY_VERSION,
      "someone-else",
      Date.now(),
    );
    listCheckInEvents.mockRejectedValue(new Error("Failed to fetch"));
    getCheckInBoard.mockRejectedValue(new Error("Failed to fetch"));

    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/The class list could not be loaded/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText("Jane L.")).not.toBeInTheDocument();
  });
});
