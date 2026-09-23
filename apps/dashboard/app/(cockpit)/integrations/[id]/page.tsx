// apps/dashboard/app/(cockpit)/integrations/[id]/page.tsx
//
// The area has no screen of its own: opening an integration lands on its first
// tab. That is the first page its manifest declares, or Connection when it
// declares none, which is also what a build with no pages at all looks like.
import { redirect } from "next/navigation";

import { integrationManifest } from "@integrations/registry";

import { CONNECTION_PAGE, integrationHref } from "@/lib/cockpit/navigation";

export default async function IntegrationAreaIndex({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const manifest = integrationManifest(id);
  // The layout already says there is no such integration. Redirecting an
  // unknown id to a tab of it would answer a question nobody asked.
  if (!manifest) return null;
  redirect(integrationHref(id, manifest.pages[0]?.id ?? CONNECTION_PAGE.id));
}
