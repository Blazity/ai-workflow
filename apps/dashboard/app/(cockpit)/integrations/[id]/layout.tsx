// apps/dashboard/app/(cockpit)/integrations/[id]/layout.tsx
//
// One integration's area: its own pages and Connection, under one sidebar
// entry.
//
// It reads the manifest registry rather than the worker, which is what keeps it
// synchronous past `params`. The tabs are a fact about the build (which pages
// this integration declares), not about the connection, so nothing here has to
// wait on a round trip, and no Suspense boundary is introduced over the
// Connection screen, whose careful behaviour under a refresh is S6's.
import { integrationManifest } from "@integrations/registry";

import { IntegrationAreaTabs } from "../integration-area-tabs";
import { UnknownIntegrationScreen } from "./connection/connection-screen";

export default async function IntegrationAreaLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const manifest = integrationManifest(id);

  // An id this build does not ship. Said once, here, so every route under the
  // area gives the same answer instead of three different kinds of nothing.
  if (!manifest) return <UnknownIntegrationScreen id={id} />;

  return (
    <div className="flex flex-col">
      <IntegrationAreaTabs id={manifest.id} name={manifest.name} pages={manifest.pages} />
      {children}
    </div>
  );
}
