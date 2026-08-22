import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LoadingPanel } from "./LoadingPanel";

describe("LoadingPanel", () => {
  it("announces the load politely, which the bare text it replaced did not", () => {
    // The only thing here a sighted user would not already have. A plain
    // <div>Loading...</div> looks identical and tells a screen reader nothing,
    // either when the load starts or when it ends.
    render(<LoadingPanel />);

    const status = screen.getByRole("status");
    expect(status).toBeVisible();
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Loading");
  });

  it("takes a label, for a screen that can say what it is fetching", () => {
    render(<LoadingPanel label="Loading the waivers" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the waivers");
  });

  it("keeps the spinner out of the accessibility tree", () => {
    // The label already says it. A second announcement of a decorative icon is
    // noise on a live region that fires on every load.
    const { container } = render(<LoadingPanel />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
