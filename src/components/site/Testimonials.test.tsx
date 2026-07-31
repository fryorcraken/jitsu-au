import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Testimonials } from "./Testimonials";
import { GOOGLE_RATING, GOOGLE_REVIEWS, GOOGLE_REVIEWS_URL } from "@/lib/google-reviews";

describe("Testimonials", () => {
  it("renders the heading and three quote cards", () => {
    render(<Testimonials />);
    expect(screen.getByRole("heading", { name: /what our members say/i })).toBeInTheDocument();
    expect(document.querySelectorAll("figure")).toHaveLength(3);
  });

  it("renders each review's text and attributes it to its Google reviewer", () => {
    render(<Testimonials />);
    const cards = document.querySelectorAll("figure");
    expect(cards).toHaveLength(GOOGLE_REVIEWS.length);
    GOOGLE_REVIEWS.forEach((review, i) => {
      expect(cards[i]).toHaveTextContent(review.name);
      expect(cards[i]).toHaveTextContent(review.text);
      expect(cards[i]).toHaveTextContent("Google review");
    });
  });

  it("accepts a custom heading", () => {
    render(<Testimonials heading="Trusted by students like you" />);
    expect(
      screen.getByRole("heading", { name: /trusted by students like you/i }),
    ).toBeInTheDocument();
  });

  it("links the rating badge out to the club's Google reviews", () => {
    render(<Testimonials />);
    const badge = screen.getByRole("link", { name: new RegExp(`${GOOGLE_RATING} on google`, "i") });
    expect(badge).toHaveAttribute("href", GOOGLE_REVIEWS_URL);
    expect(badge).toHaveAttribute("target", "_blank");
    expect(badge).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });
});
