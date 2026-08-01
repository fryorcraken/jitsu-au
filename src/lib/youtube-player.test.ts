// `loadYouTubeIframeApi` is a thin wrapper around a real script load that
// can't fully run under the test runner, so the parts worth pinning are the
// pure pieces: what options a player is built with, that `onReady`/
// `onApiChange`/`onStateChange` actually force captions off and restore the
// accessible title, and the loader's own dedup/error/retry behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPlayerOptions,
  forceCaptionsOff,
  handlePlayerReady,
  type YouTubePlayer,
} from "./youtube-player";

const IFRAME_API_SRC = "https://www.youtube.com/iframe_api";

function fakePlayer(iframe: HTMLIFrameElement | null = document.createElement("iframe")) {
  return {
    unloadModule: vi.fn(),
    getIframe: vi.fn().mockReturnValue(iframe),
    destroy: vi.fn(),
  } satisfies YouTubePlayer;
}

describe("forceCaptionsOff", () => {
  it("unloads the captions module", () => {
    const player = fakePlayer();
    forceCaptionsOff(player);
    expect(player.unloadModule).toHaveBeenCalledWith("captions");
  });
});

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
  it("targets the privacy-enhanced domain, sets the origin, and disables the related-videos rail", () => {
    const options = buildPlayerOptions("abc123", "Video title", "https://jitsu.au");
    expect(options.videoId).toBe("abc123");
    expect(options.host).toBe("https://www.youtube-nocookie.com");
    expect(options.playerVars).toEqual({ rel: 0, origin: "https://jitsu.au" });
  });

  it("wires onReady to force captions off and set the title", () => {
    const player = fakePlayer();
    const options = buildPlayerOptions("abc123", "Video title", "https://jitsu.au");
    options.events.onReady({ target: player });
    expect(player.unloadModule).toHaveBeenCalledWith("captions");
    expect(player.getIframe()?.title).toBe("Video title");
  });

  it("re-asserts captions off on onApiChange, in case the module loaded after onReady", () => {
    const player = fakePlayer();
    const options = buildPlayerOptions("abc123", "Video title", "https://jitsu.au");
    options.events.onApiChange({ target: player });
    expect(player.unloadModule).toHaveBeenCalledWith("captions");
  });

  it("re-asserts captions off on onStateChange, in case playback re-loaded the module", () => {
    const player = fakePlayer();
    const options = buildPlayerOptions("abc123", "Video title", "https://jitsu.au");
    options.events.onStateChange({ target: player, data: 1 });
    expect(player.unloadModule).toHaveBeenCalledWith("captions");
  });
});

describe("loadYouTubeIframeApi", () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.YT;
    delete window.onYouTubeIframeAPIReady;
    document.head.innerHTML = "";
  });

  afterEach(() => {
    delete window.YT;
    delete window.onYouTubeIframeAPIReady;
    document.head.innerHTML = "";
  });

  it("resolves immediately if the API is already loaded", async () => {
    const { loadYouTubeIframeApi } = await import("./youtube-player");
    window.YT = { Player: class {} } as unknown as NonNullable<Window["YT"]>;
    await expect(loadYouTubeIframeApi()).resolves.toBeUndefined();
  });

  it("injects the iframe_api script and resolves once the global ready callback fires", async () => {
    const { loadYouTubeIframeApi } = await import("./youtube-player");
    const promise = loadYouTubeIframeApi();
    const script = document.head.querySelector(`script[src="${IFRAME_API_SRC}"]`);
    expect(script).not.toBeNull();
    window.onYouTubeIframeAPIReady?.();
    await expect(promise).resolves.toBeUndefined();
  });

  it("shares one script across concurrent calls", async () => {
    const { loadYouTubeIframeApi } = await import("./youtube-player");
    void loadYouTubeIframeApi();
    void loadYouTubeIframeApi();
    const scripts = document.head.querySelectorAll(`script[src="${IFRAME_API_SRC}"]`);
    expect(scripts.length).toBe(1);
  });

  it("does not inject a second script if one is already present in the document", async () => {
    const { loadYouTubeIframeApi } = await import("./youtube-player");
    const preexisting = document.createElement("script");
    preexisting.src = IFRAME_API_SRC;
    document.head.appendChild(preexisting);

    void loadYouTubeIframeApi();

    const scripts = document.head.querySelectorAll(`script[src="${IFRAME_API_SRC}"]`);
    expect(scripts.length).toBe(1);
  });

  it("rejects and allows a retry if the script fails to load", async () => {
    const { loadYouTubeIframeApi } = await import("./youtube-player");
    const first = loadYouTubeIframeApi();
    const script = document.head.querySelector(`script[src="${IFRAME_API_SRC}"]`);
    script?.dispatchEvent(new Event("error"));
    await expect(first).rejects.toThrow();

    document.head.innerHTML = "";
    void loadYouTubeIframeApi();
    expect(document.head.querySelector(`script[src="${IFRAME_API_SRC}"]`)).not.toBeNull();
  });
});
