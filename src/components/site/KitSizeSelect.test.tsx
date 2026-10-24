import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import {
  BeltSizeSelect,
  EMPTY_SIZE_LABEL,
  GiSizeSelect,
  WAIVER_GI_EMPTY_LABEL,
} from "@/components/site/KitSizeSelect";

describe("KitSizeSelect", () => {
  it("labels the empty option 'Not on file' by default, on both pickers", () => {
    render(
      <>
        <GiSizeSelect id="gi" value="" onChange={vi.fn()} />
        <BeltSizeSelect id="belt" value="" onChange={vi.fn()} />
      </>,
    );
    const [gi, belt] = screen.getAllByRole("combobox");
    expect(within(gi).getAllByRole("option")[0]).toHaveTextContent(EMPTY_SIZE_LABEL);
    expect(within(belt).getAllByRole("option")[0]).toHaveTextContent(EMPTY_SIZE_LABEL);
    expect(EMPTY_SIZE_LABEL).toBe("Not on file");
  });

  it("takes the waiver's own empty label, which does not claim there is no size", () => {
    render(<GiSizeSelect id="gi" value="" onChange={vi.fn()} emptyLabel={WAIVER_GI_EMPTY_LABEL} />);
    const first = within(screen.getByRole("combobox")).getAllByRole("option")[0];
    expect(first).toHaveTextContent("Not sure, skip this");
    expect(first).not.toHaveTextContent(/not on file|not set/i);
  });

  it("says each gi size is for a height, not a garment measurement", () => {
    render(<GiSizeSelect id="gi" value="" onChange={vi.fn()} />);
    expect(screen.getByRole("option", { name: "5 (for 180 cm tall)" })).toBeInTheDocument();
  });
});
