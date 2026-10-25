// A preview card on a link to another part of the knowledge base.
//
// Hover a link with a mouse and, after a moment, a card shows the passage it
// points at; move away and it goes. That is the Quartz/Obsidian pattern, and it
// is what makes a syllabus full of technique names readable: "advanced body
// grab" can be looked up without leaving the belt you are reading.
//
// A phone has no hover, and this club reads on phones. So on a touch screen the
// FIRST tap on a previewable link opens the card instead of following the link,
// and a second tap on the same link (or the card's own button) follows it. That
// costs a tap for somebody who wanted to go straight there, which is the trade:
// the alternative is that a member on a phone can never peek at all. Tapping
// anywhere else closes the card. A mouse click still follows the link at once.
//
// The markdown renderer is passed in rather than imported, because the card is
// itself rendered from `kb-markdown.tsx`'s link override, and importing that
// module back from here would make the two depend on each other.
import { useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Loading } from "@/components/site/Loading";
import { useKbArticlePreview } from "@/hooks/useKbArticle";
import { articlePreview } from "@/lib/kb-preview";
import { describeLoadError } from "@/lib/load-error";

type Props = {
  /** The article the link points at. */
  slug: string;
  /** The section it points at, without the `#`. */
  hash?: string;
  /** True for a `#section` link to the article already on screen. */
  samePage?: boolean;
  /** Renders a passage of article markdown, without previews of its own. */
  renderMarkdown: (markdown: string) => ReactNode;
  /** The link itself. Must be a single element that accepts a ref. */
  children: ReactNode;
};

export function KbLinkPreview({ slug, hash, samePage = false, renderMarkdown, children }: Props) {
  const [open, setOpen] = useState(false);
  const pointerType = useRef<string>("");
  const triggerRef = useRef<HTMLAnchorElement | null>(null);

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={350} closeDelay={150}>
      <HoverCardTrigger
        asChild
        ref={triggerRef}
        onPointerDown={(event) => {
          pointerType.current = event.pointerType;
        }}
        onClick={(event) => {
          // The first tap on a touch screen peeks; the second one goes. Keyed
          // on the pointer that pressed, not on the device, so a laptop with a
          // touch screen behaves like a phone only when it is being touched.
          if (pointerType.current === "touch" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        collisionPadding={16}
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
        // A tap on the link that opened the card is "outside" the card as far
        // as the dismiss layer is concerned. Closing on it would mean the
        // second tap reopens the card instead of following the link, so a
        // touch reader could never get through.
        onPointerDownOutside={(event) => {
          if (triggerRef.current?.contains(event.target as Node)) event.preventDefault();
        }}
      >
        <PreviewBody
          slug={slug}
          hash={hash}
          samePage={samePage}
          renderMarkdown={renderMarkdown}
          onFollow={() => setOpen(false)}
        />
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * The card's contents. Its own component so the article is only asked for once
 * the card is actually open, not for every link in a long syllabus.
 */
function PreviewBody({
  slug,
  hash,
  samePage,
  renderMarkdown,
  onFollow,
}: {
  slug: string;
  hash?: string;
  samePage: boolean;
  renderMarkdown: (markdown: string) => ReactNode;
  onFollow: () => void;
}) {
  const query = useKbArticlePreview(slug);
  const article = query.data?.article ?? null;
  const redirectTo = query.data?.redirect_to ?? null;

  if (query.isPending) {
    return <Loading label="Loading a preview..." className="p-4" />;
  }

  if (query.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-muted-foreground">
        {describeLoadError(query.error, "Could not load a preview.")} Follow the link to try opening
        it.
      </p>
    );
  }

  // A link entry: there is no text here, only a page elsewhere on the site.
  if (redirectTo || !article) {
    return (
      <div className="space-y-3 p-4 text-sm">
        <p className="text-muted-foreground">This one opens another page on the site.</p>
        {redirectTo && <FollowLink to={redirectTo} label="Go there" onFollow={onFollow} />}
      </div>
    );
  }

  const preview = articlePreview(article.body_md, hash);

  return (
    <div className="flex max-h-[min(24rem,60vh)] flex-col">
      <div className="border-b px-4 py-3">
        <p className="text-xs text-muted-foreground">{article.title}</p>
        <p className="font-semibold leading-snug">{preview.heading ?? article.title}</p>
      </div>
      <div className="min-h-0 overflow-y-auto px-4 py-3 text-sm">
        {preview.missingSection && (
          <p className="mb-2 text-xs text-muted-foreground">
            This article has no section called{" "}
            <code className="font-mono">#{preview.missingSection}</code> any more. Here is the start
            of it instead.
          </p>
        )}
        {preview.markdown ? (
          renderMarkdown(preview.markdown)
        ) : (
          <p className="text-muted-foreground">Nothing is written under this heading yet.</p>
        )}
        {preview.truncated && (
          <p className="text-xs text-muted-foreground">There is more in the article.</p>
        )}
      </div>
      <div className="border-t px-4 py-2">
        {samePage ? (
          <a
            href={`#${hash ?? ""}`}
            onClick={onFollow}
            className="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-2"
          >
            Go to this section <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </a>
        ) : (
          <FollowLink
            to="/kb/$slug"
            params={{ slug }}
            hash={hash}
            label={preview.heading ? "Go to this section" : "Read the article"}
            onFollow={onFollow}
          />
        )}
      </div>
    </div>
  );
}

function FollowLink({
  to,
  params,
  hash,
  label,
  onFollow,
}: {
  to: string;
  params?: { slug: string };
  hash?: string;
  label: string;
  onFollow: () => void;
}) {
  return (
    <Link
      to={to}
      params={params}
      hash={hash}
      onClick={onFollow}
      className="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-2"
    >
      {label} <ArrowRight className="h-4 w-4" aria-hidden="true" />
    </Link>
  );
}
