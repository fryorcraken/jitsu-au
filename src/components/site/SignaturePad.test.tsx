// The signature pad used to erase itself.
//
// Its resize handler called `pad.clear()`, and resizing the backing store blanks
// the canvas anyway. On a phone that meant: draw your signature, tap the next
// field, the on-screen keyboard opens, the viewport resizes, and the signature
// is gone. People did not notice until the form refused to submit, by which
// point they had usually stopped trusting the page.
//
// `signature_pad` is mocked rather than run for real: jsdom has no canvas 2D
// context, so the library cannot draw. What is under test is this component's
// own capture-and-restore logic around the resize, which the mock makes visible.
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

const SIGNATURE = "data:image/png;base64,SIGNED";

/** Records what the component asks the pad to do, in order. */
const calls: string[] = [];

let lastPad: FakeSignaturePad | null = null;

/** Records the pad the component just built, so tests can drive it. */
function register(pad: FakeSignaturePad) {
  lastPad = pad;
}

class FakeSignaturePad {
  private data = "";
  private listeners = new Map<string, Set<() => void>>();

  constructor(
    public canvas: HTMLCanvasElement,
    public options: unknown,
  ) {
    register(this);
  }

  isEmpty() {
    return this.data === "";
  }

  toDataURL() {
    return this.data;
  }

  clear() {
    calls.push("clear");
    this.data = "";
  }

  fromDataURL(dataUrl: string) {
    calls.push(`fromDataURL:${dataUrl}`);
    this.data = dataUrl;
    return Promise.resolve();
  }

  addEventListener(type: string, fn: () => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }

  off() {}

  /** Test helper: pretend somebody drew on it. */
  draw(dataUrl: string) {
    this.data = dataUrl;
    for (const fn of this.listeners.get("endStroke") ?? []) fn();
  }
}

vi.mock("signature_pad", () => ({ default: FakeSignaturePad }));

const { SignaturePad } = await import("./SignaturePad");

beforeEach(() => {
  calls.length = 0;
  lastPad = null;
  // jsdom reports every element as 0x0, which the component treats as a hidden
  // pad and skips. Give it a real size so the resize path actually runs.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 600,
    height: 160,
    top: 0,
    left: 0,
    right: 600,
    bottom: 160,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

function resizeWindow() {
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

describe("SignaturePad", () => {
  it("renders a labelled canvas and a clear button", () => {
    render(<SignaturePad ariaLabel="Your signature" />);
    expect(screen.getByLabelText("Your signature")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument();
  });

  it("keeps the signature when the window resizes", () => {
    // The bug: opening the phone keyboard fires a resize, and the signature the
    // person had just drawn was silently wiped.
    render(<SignaturePad />);
    act(() => lastPad!.draw(SIGNATURE));
    calls.length = 0;

    resizeWindow();

    expect(lastPad!.toDataURL()).toBe(SIGNATURE);
    expect(calls).toContain(`fromDataURL:${SIGNATURE}`);
  });

  it("does not resize away a signature while the pad is hidden", () => {
    // The draw/type tab switch unmounts nothing, it just hides the pad, and a
    // hidden element measures 0x0. Resizing to that would destroy the signature
    // with no way back.
    render(<SignaturePad />);
    act(() => lastPad!.draw(SIGNATURE));
    calls.length = 0;

    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    resizeWindow();

    expect(lastPad!.toDataURL()).toBe(SIGNATURE);
    expect(calls).toEqual([]);
  });

  it("starts from a restored draft signature", () => {
    render(<SignaturePad initialDataUrl={SIGNATURE} />);
    expect(calls).toContain(`fromDataURL:${SIGNATURE}`);
    expect(lastPad!.toDataURL()).toBe(SIGNATURE);
  });

  it("reports strokes and clearing through onChange", () => {
    const onChange = vi.fn();
    render(<SignaturePad onChange={onChange} />);

    act(() => lastPad!.draw(SIGNATURE));
    expect(onChange).toHaveBeenCalledWith(SIGNATURE);

    act(() => {
      screen.getByRole("button", { name: /clear/i }).click();
    });
    expect(onChange).toHaveBeenLastCalledWith("");
  });
});
