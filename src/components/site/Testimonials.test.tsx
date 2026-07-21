import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Testimonials, PLACEHOLDER, GOOGLE_REVIEWS_URL } from "./Testimonials";

describe("Testimonials", () => {
  it("renders the heading and at least two quote cards", () => {
    render(<Testimonials />);
    expect(screen.getByRole("heading", { name: /what our members say/i })).toBeInTheDocument();
    // Each quote is a <figure>; expect the reusable strip to carry 2–3 of them.
    const quotes = document.querySelectorAll("figure");
    expect(quotes.length).toBeGreaterThanOrEqual(2);
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

  it("shows an unmistakable warning while placeholder content is in use", () => {
    render(<Testimonials />);
    if (PLACEHOLDER) {
      // Guards the requirement that fabricated testimonials cannot ship silently:
      // as long as the placeholders are live, a loud alert must be on screen.
      expect(screen.getByRole("alert")).toHaveTextContent(/placeholder/i);
    } else {
      // Once real reviews replace the placeholders, no warning should render.
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
  });
});
