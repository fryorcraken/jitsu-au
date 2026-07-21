import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { PasswordInput } from "./PasswordInput";

describe("PasswordInput", () => {
  it("masks the value by default", () => {
    render(<PasswordInput aria-label="Password" defaultValue="hunter2" />);
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Show password" })).toBeInTheDocument();
  });

  it("reveals and re-hides the value when the toggle is clicked", async () => {
    render(<PasswordInput aria-label="Password" defaultValue="hunter2" />);
    const field = screen.getByLabelText("Password");

    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(field).toHaveAttribute("type", "text");

    await userEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(field).toHaveAttribute("type", "password");
  });

  it("forwards input props such as required and minLength", () => {
    render(<PasswordInput aria-label="Password" required minLength={8} />);
    const field = screen.getByLabelText("Password");
    expect(field).toBeRequired();
    expect(field).toHaveAttribute("minLength", "8");
  });

  it("keeps the toggle out of the tab order", () => {
    render(<PasswordInput aria-label="Password" />);
    expect(screen.getByRole("button", { name: "Show password" })).toHaveAttribute("tabindex", "-1");
  });
});
