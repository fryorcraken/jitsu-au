// Extends Vitest's `expect` with jest-dom matchers (toBeInTheDocument, etc.)
// and registers automatic DOM cleanup after each test.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
