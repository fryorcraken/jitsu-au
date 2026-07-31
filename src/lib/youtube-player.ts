/**
 * YouTube IFrame Player API — client-only, no server imports.
 *
 * A plain `<iframe src="...?cc_load_policy=0">` embed cannot force captions
 * off: `cc_load_policy` only ever forces captions *on* (value 1); its default
 * (0, or omitted) just means "follow whatever already turned them on" —
 * a viewer's saved caption preference, a browser/OS accessibility setting, or
 * YouTube inferring the viewer's locale differs from the video's audio and
 * auto-surfacing translated captions. None of those are things the embedding
 * page controls via the URL. The only lever that overrides all of them is the
 * JS Player API's `unloadModule('captions')`, called once the player is
 * ready — see `handlePlayerReady`.
 */

export interface YouTubePlayer {
  unloadModule: (moduleName: string) => void;
  getIframe: () => HTMLIFrameElement | null;
  destroy: () => void;
}

export interface YouTubePlayerOptions {
  videoId: string;
  host: string;
  playerVars: Record<string, string | number>;
  events: {
    onReady: (event: { target: YouTubePlayer }) => void;
  };
}

declare global {
  interface Window {
    YT?: {
      Player: new (element: string | HTMLElement, options: YouTubePlayerOptions) => YouTubePlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

const IFRAME_API_SRC = "https://www.youtube.com/iframe_api";

let apiPromise: Promise<void> | null = null;

/** Loads the YouTube IFrame Player API script once, sharing one promise across every embed on the page. */
export function loadYouTubeIframeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = IFRAME_API_SRC;
    document.head.appendChild(script);
  });
  return apiPromise;
}

/**
 * Forces captions off regardless of why the player would otherwise show them,
 * and restores the given accessible title: YouTube's generated iframe carries
 * its own title, overwriting whatever the embedding page intended.
 */
export function handlePlayerReady(player: YouTubePlayer, title: string): void {
  player.unloadModule("captions");
  const iframe = player.getIframe();
  if (iframe) iframe.title = title;
}

export function buildPlayerOptions(videoId: string, title: string): YouTubePlayerOptions {
  return {
    videoId,
    host: "https://www.youtube-nocookie.com",
    playerVars: { rel: 0 },
    events: {
      onReady: (event) => handlePlayerReady(event.target, title),
    },
  };
}
