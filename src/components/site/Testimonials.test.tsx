import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Testimonials, GOOGLE_REVIEWS_URL } from "./Testimonials";

describe("Testimonials", () => {
  it("renders the heading and three quote cards", () => {
    render(<Testimonials />);
    expect(screen.getByRole("heading", { name: /what our members say/i })).toBeInTheDocument();
    expect(document.querySelectorAll("figure")).toHaveLength(3);
  });

  it("accepts a custom heading", () => {
    render(<Testimonials heading="Trusted by students like you" />);
    expect(
      screen.getByRole("heading", { name: /trusted by students like you/i }),
    ).toBeInTheDocument();
  });

  it("links the rating badge out to the club's Google reviews", () => {
    render(<Testimonials />);
    const badge = screen.getByRole("link", { name: /on google/i });
    expect(badge).toHaveAttribute("href", GOOGLE_REVIEWS_URL);
    expect(badge).toHaveAttribute("target", "_blank");
    expect(badge).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("shows the example-reviews note so placeholder content can't ship silently", () => {
    render(<Testimonials />);
    expect(screen.getByText(/example reviews for layout/i)).toBeInTheDocument();
  });
});
