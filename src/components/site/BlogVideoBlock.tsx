import { YouTubeEmbed } from "@/components/site/YouTubeEmbed";
import { extractYouTubeId } from "@/lib/blog-content";

/**
 * Renders one `[[video:<url>]]` block from a post body: a real inline embed
 * for a recognised YouTube link, or a plain "watch the video" link for
 * anything else. Shared by the public post page and the manager editor's
 * live preview so the two never drift.
 */
export function BlogVideoBlock({
  url,
  title,
  className,
}: {
  url: string;
  title: string;
  className?: string;
}) {
  const videoId = extractYouTubeId(url);
  if (videoId)
    return <YouTubeEmbed videoId={videoId} title={title} className={className ?? "my-6"} />;
  return (
    <p className="mb-4">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2"
      >
        Watch the video ↗
      </a>
    </p>
  );
}
