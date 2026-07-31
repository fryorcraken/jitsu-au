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
    loadYouTubeIframeApi.mockImplementation(async () => {
      window.YT = { Player: playerCtor } as unknown as NonNullable<Window["YT"]>;
    });
    buildPlayerOptions.mockReturnValue(playerOptions);
  });

  afterEach(() => {
    delete window.YT;
  });

  it("waits for the iframe API then creates a privacy-enhanced player targeting the container", async () => {
    const { container } = render(
      <YouTubeEmbed videoId="jm75EhP1zMQ" title="UTS Jitsu class in action" />,
    );

    await waitFor(() => expect(playerCtor).toHaveBeenCalledTimes(1));

    expect(buildPlayerOptions).toHaveBeenCalledWith("jm75EhP1zMQ", "UTS Jitsu class in action");
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
});
