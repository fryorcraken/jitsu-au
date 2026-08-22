import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Loading } from "./Loading";

describe("Loading", () => {
  it("announces the wait politely instead of rendering bare text", () => {
    render(<Loading />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Loading...");
  });

  it("takes a label for screens that can say what they are waiting on", () => {
    render(<Loading label="Loading the roster" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the roster");
  });
});
