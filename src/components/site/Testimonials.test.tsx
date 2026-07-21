import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Testimonials } from "./Testimonials";
import { GOOGLE_REVIEWS_URL } from "@/lib/testimonials";

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

  it("renders the unmistakable warning while the shipped data is still placeholder", () => {
    // The strip currently ships placeholder reviews, so the guard must be visible.
    render(<Testimonials />);
    expect(screen.getByRole("alert")).toHaveTextContent(/placeholder/i);
  });
});
