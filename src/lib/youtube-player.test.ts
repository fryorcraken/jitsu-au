// `loadYouTubeIframeApi` is a thin wrapper around a real script load that
// can't meaningfully run under the test runner, so the parts worth pinning
// are the pure pieces: what options a player is built with, and that
// `onReady` actually forces captions off and restores the accessible title.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPlayerOptions,
  handlePlayerReady,
  loadYouTubeIframeApi,
  type YouTubePlayer,
} from "./youtube-player";

function fakePlayer(iframe: HTMLIFrameElement | null = document.createElement("iframe")) {
  return {
    unloadModule: vi.fn(),
    getIframe: vi.fn().mockReturnValue(iframe),
    destroy: vi.fn(),
  } satisfies YouTubePlayer;
}

describe("handlePlayerReady", () => {
  it("forces captions off and restores the accessible title", () => {
    const player = fakePlayer();
    handlePlayerReady(player, "UTS Jitsu class in action");
    expect(player.unloadModule).toHaveBeenCalledWith("captions");
    expect(player.getIframe()?.title).toBe("UTS Jitsu class in action");
  });

  it("still forces captions off if the generated iframe isn't available yet", () => {
    const player = fakePlayer(null);
    expect(() => handlePlayerReady(player, "Title")).not.toThrow();
    expect(player.unloadModule).toHaveBeenCalledWith("captions");
  });
});

describe("buildPlayerOptions", () => {
  it("targets the privacy-enhanced domain and disables the related-videos rail", () => {
    const options = buildPlayerOptions("abc123", "Video title");
    expect(options.videoId).toBe("abc123");
    expect(options.host).toBe("https://www.youtube-nocookie.com");
    expect(options.playerVars).toEqual({ rel: 0 });
  });

  it("wires onReady to force captions off", () => {
    const player = fakePlayer();
    const options = buildPlayerOptions("abc123", "Video title");
    options.events.onReady({ target: player });
    expect(player.unloadModule).toHaveBeenCalledWith("captions");
  });
});

describe("loadYouTubeIframeApi", () => {
  afterEach(() => {
    delete window.YT;
    delete window.onYouTubeIframeAPIReady;
    document.head.innerHTML = "";
  });

  it("resolves immediately if the API is already loaded", async () => {
    window.YT = { Player: class {} } as unknown as NonNullable<Window["YT"]>;
    await expect(loadYouTubeIframeApi()).resolves.toBeUndefined();
  });

  it("injects the iframe_api script", () => {
    void loadYouTubeIframeApi();
    const script = document.head.querySelector(`script[src="https://www.youtube.com/iframe_api"]`);
    expect(script).not.toBeNull();
  });
});
