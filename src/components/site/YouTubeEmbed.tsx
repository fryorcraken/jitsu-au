import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { buildPlayerOptions, loadYouTubeIframeApi, type YouTubePlayer } from "@/lib/youtube-player";

type YouTubeEmbedProps = {
  videoId: string;
  title: string;
  className?: string;
};

export function YouTubeEmbed({ videoId, title, className }: YouTubeEmbedProps) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [isNear, setIsNear] = useState(false);

  // Defers loading the YouTube API (and its network requests) until the embed
  // is close to the viewport, matching the lazy-loading a plain
  // <iframe loading="lazy"> used to give for free.
  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    if (typeof IntersectionObserver === "undefined") {
      setIsNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setIsNear(true);
        observer.disconnect();
      },
      { rootMargin: "200px" },
    );
    observer.observe(outer);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isNear) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    // A fresh mount point per effect run: the YouTube API replaces this node
    // with its own <iframe>, so reusing the same node across a videoId/title
    // change would hand the player a node that's already been detached.
    const mountNode = document.createElement("div");
    mountNode.className = "h-full w-full";
    wrapper.appendChild(mountNode);

    let cancelled = false;
    let player: YouTubePlayer | null = null;

    loadYouTubeIframeApi()
      .then(() => {
        if (cancelled || !window.YT) return;
        player = new window.YT.Player(
          mountNode,
          buildPlayerOptions(videoId, title, window.location.origin),
        );
      })
      .catch(() => {
        // Load failed (network, ad blocker, ...): the noscript fallback below
        // renders identically for these visitors as it does with JS off.
      });

    return () => {
      cancelled = true;
      try {
        player?.destroy();
      } catch {
        // YouTube's destroy() can throw if its iframe is already gone.
      }
      if (wrapper.contains(mountNode)) wrapper.removeChild(mountNode);
    };
  }, [isNear, videoId, title]);

  return (
    <div
      ref={outerRef}
      className={cn(
        "relative aspect-video w-full overflow-hidden rounded-2xl shadow-lg ring-1 ring-black/5",
        "[&_iframe]:absolute [&_iframe]:inset-0 [&_iframe]:h-full [&_iframe]:w-full",
        className,
      )}
    >
      <div ref={wrapperRef} className="h-full w-full" />
      <noscript>
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${videoId}?rel=0`}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      </noscript>
    </div>
  );
}
