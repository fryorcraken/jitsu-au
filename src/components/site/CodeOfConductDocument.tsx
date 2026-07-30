import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  CODE_OF_CONDUCT_BODY_MD,
  parseCodeOfConductBlocks,
  parseCodeOfConductSpans,
} from "@/lib/code-of-conduct";

/**
 * The club's code of conduct, rendered for reading.
 *
 * Unlike `WaiverDocument` this is not a facsimile of a signed PDF, so it does
 * not force the paper look: there is no PDF to match, and the page is meant to
 * be read in whichever theme the visitor is using. Nothing about a person
 * appears in it, because the document has no placeholders — it is house rules,
 * identical for everybody.
 */
export function CodeOfConductDocument({
  body = CODE_OF_CONDUCT_BODY_MD,
  className,
}: {
  body?: string;
  className?: string;
}) {
  const blocks = parseCodeOfConductBlocks(body);

  return (
    <article className={cn("space-y-4", className)}>
      {blocks.map((block, i) => {
        if (block.kind === "h1") {
          return (
            <h2 key={i} className="text-2xl font-bold tracking-tight">
              {renderSpans(block.text)}
            </h2>
          );
        }
        if (block.kind === "h2") {
          return (
            <h3 key={i} className="pt-4 text-lg font-semibold text-primary">
              {renderSpans(block.text)}
            </h3>
          );
        }
        if (block.kind === "ul") {
          return (
            <ul key={i} className="ml-5 list-disc space-y-2">
              {block.items.map((item, j) => (
                <li key={j} className="text-sm leading-relaxed text-muted-foreground">
                  {renderSpans(item)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
            {renderSpans(block.text)}
          </p>
        );
      })}
    </article>
  );
}

/** Render one line's bold runs and bare URLs. */
function renderSpans(line: string): ReactNode {
  return parseCodeOfConductSpans(line).map((span, i) => {
    if (span.kind === "bold") {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {span.text}
        </strong>
      );
    }
    if (span.kind === "link") {
      return (
        <a
          key={i}
          href={span.href}
          target="_blank"
          rel="noopener noreferrer"
          className="break-words text-primary underline underline-offset-2"
        >
          {span.text}
        </a>
      );
    }
    return <Fragment key={i}>{span.text}</Fragment>;
  });
}
