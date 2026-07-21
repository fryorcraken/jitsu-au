import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";

// Smoke test that proves the jsdom + Testing Library setup works for components.
describe("Button", () => {
  it("renders its children", () => {
    render(<Button>Sign waiver</Button>);
    expect(screen.getByRole("button", { name: "Sign waiver" })).toBeInTheDocument();
  });

  it("applies variant/size classes", () => {
    render(
      <Button variant="destructive" size="sm">
        Delete
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn.className).toContain("bg-destructive");
    expect(btn.className).toContain("h-8");
  });

  it("fires onClick when clicked", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not fire onClick when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Go
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders as a child element when asChild is set", () => {
    render(
      <Button asChild>
        <a href="/waiver">Waiver link</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Waiver link" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/waiver");
  });
});
