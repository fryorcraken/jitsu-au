import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { buildPlayerOptions, loadYouTubeIframeApi, type YouTubePlayer } from "@/lib/youtube-player";

type YouTubeEmbedProps = {
  videoId: string;
  title: string;
  className?: string;
};

export function YouTubeEmbed({ videoId, title, className }: YouTubeEmbedProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let player: YouTubePlayer | null = null;

    void loadYouTubeIframeApi().then(() => {
      if (cancelled || !window.YT) return;
      player = new window.YT.Player(container, buildPlayerOptions(videoId, title));
    });

    return () => {
      cancelled = true;
      player?.destroy();
    };
  }, [videoId, title]);

  return (
    <div
      className={cn(
        "aspect-video w-full overflow-hidden rounded-2xl shadow-lg ring-1 ring-black/5",
        className,
      )}
    >
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
