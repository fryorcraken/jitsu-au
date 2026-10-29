// Which article is on screen, for the links inside it.
//
// A bare `#section` link says nothing about which article it belongs to, so
// without this a link from one belt to another in the same syllabus could not
// show a preview card (`KbLinkPreview`). The reader provides it; outside the
// reader (the manager's editor preview) it is null, and a fragment link there
// simply has no card.
import { createContext, useContext } from "react";

export const CurrentKbArticle = createContext<string | null>(null);

export function useCurrentKbArticleSlug(): string | null {
  return useContext(CurrentKbArticle);
}
