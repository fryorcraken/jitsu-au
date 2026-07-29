import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signInWithOtp = vi.fn();
const signInWithPassword = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/auth-persistence", () => ({ rememberSession: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      signInWithOtp: (...args: unknown[]) => signInWithOtp(...args),
      signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
    },
  },
}));

import { SignInForms } from "./SignInForms";

async function requestLink(email: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/email/i), email);
  await user.click(screen.getByRole("button", { name: /^sign in$/i }));
  return user;
}

beforeEach(() => {
  signInWithOtp.mockReset().mockResolvedValue({ data: {}, error: null });
  signInWithPassword.mockReset().mockResolvedValue({ data: {}, error: null });
});

describe("SignInForms", () => {
  it("confirms the address a sign-in link was requested for", async () => {
    render(<SignInForms />);
    await requestLink("member@example.com");

    expect(signInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({ email: "member@example.com" }),
    );
    expect(screen.getByText(/we've sent a sign-in link/i)).toBeInTheDocument();
    expect(screen.getByText("member@example.com")).toBeInTheDocument();
  });

  it("goes back to the email form, prefilled, from the sent screen", async () => {
    render(<SignInForms />);
    const user = await requestLink("typo@example.con");

    await user.click(screen.getByRole("button", { name: /use a different email/i }));

    const field = screen.getByLabelText(/email/i);
    expect(field).toHaveValue("typo@example.con");
    expect(screen.queryByText(/we've sent a sign-in link/i)).not.toBeInTheDocument();

    // The corrected address is the one the second link goes to.
    await user.clear(field);
    await user.type(field, "member@example.com");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(signInWithOtp).toHaveBeenLastCalledWith(
      expect.objectContaining({ email: "member@example.com" }),
    );
  });

  it("carries the address into the password form and back again", async () => {
    render(<SignInForms />);
    const user = await requestLink("member@example.com");

    await user.click(screen.getByRole("button", { name: /login with password/i }));
    expect(screen.getByText(/signing in as/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back to email sign-in/i }));
    expect(screen.getByLabelText(/email/i)).toHaveValue("member@example.com");
  });

  it("never creates an account from the sign-in link", async () => {
    render(<SignInForms />);
    await requestLink("stranger@example.com");

    expect(signInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ shouldCreateUser: false }),
      }),
    );
  });
});
