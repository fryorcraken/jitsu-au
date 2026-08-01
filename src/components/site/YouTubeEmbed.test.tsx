import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YouTubeEmbed } from "./YouTubeEmbed";

const { loadYouTubeIframeApi, buildPlayerOptions } = vi.hoisted(() => ({
  loadYouTubeIframeApi: vi.fn(),
  buildPlayerOptions: vi.fn(),
}));

vi.mock("@/lib/youtube-player", () => ({ loadYouTubeIframeApi, buildPlayerOptions }));

describe("YouTubeEmbed", () => {
  const destroy = vi.fn();
  const playerOptions = { videoId: "jm75EhP1zMQ", host: "https://www.youtube-nocookie.com" };
  const playerCtor = vi.fn(function FakePlayer(
    this: { destroy: typeof destroy },
    _element: HTMLElement,
    _options: typeof playerOptions,
  ) {
    this.destroy = destroy;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom has no IntersectionObserver, so the component treats the embed as
    // always-near and mounts immediately — matching every test below, which
    // asserts on that immediate mount.
    loadYouTubeIframeApi.mockImplementation(async () => {
      window.YT = { Player: playerCtor } as unknown as NonNullable<Window["YT"]>;
    });
    buildPlayerOptions.mockReturnValue(playerOptions);
  });

  afterEach(() => {
    delete window.YT;
  });

  it("waits for the iframe API then creates a player targeting a fresh mount node", async () => {
    const { container } = render(
      <YouTubeEmbed videoId="jm75EhP1zMQ" title="UTS Jitsu class in action" />,
    );

    await waitFor(() => expect(playerCtor).toHaveBeenCalledTimes(1));

    expect(buildPlayerOptions).toHaveBeenCalledWith(
      "jm75EhP1zMQ",
      "UTS Jitsu class in action",
      window.location.origin,
    );
    const [element, options] = playerCtor.mock.calls[0];
    expect(container.contains(element)).toBe(true);
    expect(options).toBe(playerOptions);
  });

  it("destroys the player on unmount", async () => {
    const { unmount } = render(
      <YouTubeEmbed videoId="jm75EhP1zMQ" title="UTS Jitsu class in action" />,
    );
    await waitFor(() => expect(playerCtor).toHaveBeenCalledTimes(1));

    unmount();

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("does not construct a player if unmounted before the loader resolves", async () => {
    let resolveLoader = () => {};
    loadYouTubeIframeApi.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveLoader = () => {
            window.YT = { Player: playerCtor } as unknown as NonNullable<Window["YT"]>;
            resolve();
          };
        }),
    );

    const { unmount } = render(<YouTubeEmbed videoId="jm75EhP1zMQ" title="Title" />);
    unmount();
    resolveLoader();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(playerCtor).not.toHaveBeenCalled();
  });

  it("tears down the old player and mounts a fresh node when videoId changes", async () => {
    const { rerender, container } = render(<YouTubeEmbed videoId="a" title="A" />);
    await waitFor(() => expect(playerCtor).toHaveBeenCalledTimes(1));
    const firstElement = playerCtor.mock.calls[0][0];

    rerender(<YouTubeEmbed videoId="b" title="B" />);
    await waitFor(() => expect(playerCtor).toHaveBeenCalledTimes(2));
    const secondElement = playerCtor.mock.calls[1][0];

    expect(secondElement).not.toBe(firstElement);
    expect(container.contains(secondElement)).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("defers loading the player until the embed is near the viewport", async () => {
    let observedCallback: IntersectionObserverCallback | undefined;
    const disconnect = vi.fn();
    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        observedCallback = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
      unobserve = vi.fn();
      takeRecords = vi.fn(() => []);
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    render(<YouTubeEmbed videoId="jm75EhP1zMQ" title="Title" />);

    expect(loadYouTubeIframeApi).not.toHaveBeenCalled();

    observedCallback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      new FakeIntersectionObserver(() => {}) as unknown as IntersectionObserver,
    );

    await waitFor(() => expect(loadYouTubeIframeApi).toHaveBeenCalled());
    expect(disconnect).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
