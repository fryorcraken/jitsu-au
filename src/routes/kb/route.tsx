// The layout route for the whole knowledge base.
//
// Everything under `/kb` renders inside `KbLayout` instead of `SiteLayout`, so
// the section has its own top bar, sidebar and footer. Its children must NOT
// wrap themselves in `SiteLayout` the way every other public route does — that
// would put the marketing chrome back on top of this one.
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { KbLayout } from "@/components/site/KbLayout";

export const Route = createFileRoute("/kb")({
  component: KbSection,
});

function KbSection() {
  return (
    <KbLayout>
      <Outlet />
    </KbLayout>
  );
}
