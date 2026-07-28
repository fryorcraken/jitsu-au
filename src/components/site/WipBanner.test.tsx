import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WipBanner } from "./WipBanner";

describe("WipBanner", () => {
  it("tells visitors the site is a work in progress", () => {
    render(<WipBanner />);

    expect(screen.getByText(/work in progress/i)).toBeInTheDocument();
  });

  it("links to the official club website", () => {
    render(<WipBanner />);

    const link = screen.getByRole("link", { name: /utsjitsu\.com\.au/i });
    expect(link).toHaveAttribute("href", "https://utsjitsu.com.au");
  });

  it("cannot be dismissed", () => {
    render(<WipBanner />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
