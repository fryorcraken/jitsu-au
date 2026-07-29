import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Pill } from "./StatusPill";
import { ROLE_CLASS, coverageClass, lifecycleClass } from "@/lib/status-colours";

describe("Pill", () => {
  it("renders its label", () => {
    render(<Pill label="pending" className={lifecycleClass("applicant")} />);
    expect(screen.getByText("pending")).toBeInTheDocument();
  });

  it("capitalises the label", () => {
    // Statuses and roles are stored lowercase. Each screen used to decide the
    // casing for itself, so a role read "manager" on the user list and
    // "Manager" on the person page.
    render(<Pill label="manager" className={ROLE_CLASS} />);
    expect(screen.getByText("manager")).toHaveClass("capitalize");
  });

  it("leaves a written label alone when asked", () => {
    // The check-in board badges a plan name, not an enum value. Capitalising it
    // would render "Unlimited Monthly".
    render(<Pill label="Unlimited monthly" className={coverageClass("period")} preserveCase />);
    expect(screen.getByText("Unlimited monthly")).not.toHaveClass("capitalize");
  });

  it("wears the colour it is given, on top of the shared badge shape", () => {
    render(<Pill label="member" className={lifecycleClass("member")} />);
    const pill = screen.getByText("member");
    expect(pill).toHaveClass("rounded-full");
    expect(pill).toHaveClass("bg-green-100");
  });
});
