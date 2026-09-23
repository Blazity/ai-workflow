// apps/dashboard/app/(cockpit)/integrations/[id]/[page]/page.tsx
//
// One page an integration contributes. `connection` is a static sibling of this
// dynamic segment, so Next resolves S6's screen before ever reaching here.
import { ContributedPage } from "../../contributed-page";

/**
 * Long enough for the render to outlive what it waits on: the integrations
 * list, then the page's read, which is given `PROVIDER_CALL_CEILING_MS`
 * because the worker gives the provider its whole budget. The platform's
 * default for a function that is not on Fluid compute is 15 seconds on Pro,
 * which would cut a slow provider off before the worker could say so. A
 * literal, because Next reads segment config statically;
 * `contributed-page-wait.test.ts` holds it above the ceiling.
 */
export const maxDuration = 60;

export default async function IntegrationContributedPage({
  params,
}: {
  params: Promise<{ id: string; page: string }>;
}) {
  const { id, page } = await params;
  return <ContributedPage id={id} pageId={page} />;
}
