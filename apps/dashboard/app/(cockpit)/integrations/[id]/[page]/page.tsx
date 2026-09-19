// apps/dashboard/app/(cockpit)/integrations/[id]/[page]/page.tsx
//
// One page an integration contributes. `connection` is a static sibling of this
// dynamic segment, so Next resolves S6's screen before ever reaching here.
import { ContributedPage } from "../../contributed-page";

export default async function IntegrationContributedPage({
  params,
}: {
  params: Promise<{ id: string; page: string }>;
}) {
  const { id, page } = await params;
  return <ContributedPage id={id} pageId={page} />;
}
