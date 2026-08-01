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
 * JS Player API's `unloadModule('captions')` — see `forceCaptionsOff`.
 *
 * The captions module is loaded lazily and isn't guaranteed to exist yet at
 * `onReady` (YouTube's own docs note the related `onApiChange` event can wait
 * until playback starts), so `forceCaptionsOff` is called again from
 * `onApiChange` and `onStateChange` as a defensive re-assertion — unloading an
 * already-unloaded module is a harmless no-op.
 *
 * Trade-off, on purpose: `unloadModule` removes the captions *module*, not
 * just today's default display, which also takes the player's own CC button
 * with it — a viewer can't turn captions back on for this embed. There's no
 * reliably documented API to default captions off while leaving the module
 * (and its toggle) intact, so this accepts that trade-off rather than ship an
 * unverified "soft off" call.
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
    onApiChange: (event: { target: YouTubePlayer }) => void;
    onStateChange: (event: { target: YouTubePlayer; data: number }) => void;
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

  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };

    // Something else may have already injected this exact script (another
    // copy of this module across a bundle boundary, a hand-added tag, etc.);
    // don't duplicate it, just wait for the ready callback wired above.
    if (document.querySelector(`script[src="${IFRAME_API_SRC}"]`)) return;

    const script = document.createElement("script");
    script.src = IFRAME_API_SRC;
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      reject(new Error("Failed to load the YouTube IFrame API"));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

export function forceCaptionsOff(player: YouTubePlayer): void {
  player.unloadModule("captions");
}

/**
 * Forces captions off and restores the given accessible title: YouTube's
 * generated iframe carries its own title, overwriting whatever the embedding
 * page intended.
 */
export function handlePlayerReady(player: YouTubePlayer, title: string): void {
  forceCaptionsOff(player);
  const iframe = player.getIframe();
  if (iframe) iframe.title = title;
}

export function buildPlayerOptions(
  videoId: string,
  title: string,
  origin: string,
): YouTubePlayerOptions {
  return {
    videoId,
    host: "https://www.youtube-nocookie.com",
    playerVars: { rel: 0, origin },
    events: {
      onReady: (event) => handlePlayerReady(event.target, title),
      onApiChange: (event) => forceCaptionsOff(event.target),
      onStateChange: (event) => forceCaptionsOff(event.target),
    },
  };
}
