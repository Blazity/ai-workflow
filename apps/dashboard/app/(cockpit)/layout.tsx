// apps/dashboard/app/(cockpit)/layout.tsx
import { requireSession } from "@/lib/auth/session";
import type { CockpitIntegration } from "@/lib/cockpit/navigation";
import { readIntegrationsList } from "@/lib/integrations/list";

import { CockpitShell } from "./cockpit-shell";

/**
 * The sidebar carries one entry per connected, enabled integration, so the
 * chrome needs that list on every screen and this is the only place it is read.
 *
 * It fails soft on purpose. A worker that does not answer leaves the core
 * groups standing and the Integrations page reachable, which is where an admin
 * would go to find out why; a cockpit that refused to render because a list of
 * plugins could not be read would be the worse failure by a distance.
 */
async function cockpitIntegrations(): Promise<readonly CockpitIntegration[]> {
  const list = await readIntegrationsList();
  return (list?.integrations ?? []).map((integration) => ({
    id: integration.id,
    name: integration.name,
    pages: integration.pages,
    // `usable` is the resolver's own word for connected and enabled, which is
    // the question the sidebar asks. Reading `status` here would be a second
    // derivation of it.
    usable: integration.state.usable,
  }));
}

export default async function CockpitLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  const integrations = await cockpitIntegrations();
  return (
    <CockpitShell session={session} integrations={integrations}>
      {children}
    </CockpitShell>
  );
}
