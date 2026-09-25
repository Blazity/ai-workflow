// apps/dashboard/app/(cockpit)/layout.tsx
import { requireSession } from "@/lib/auth/session";
import type { CockpitIntegration } from "@/lib/cockpit/navigation";
import { integrationsFingerprint } from "@/lib/integrations/fingerprint";
import { readIntegrationsList } from "@/lib/integrations/list";

import { CockpitShell } from "./cockpit-shell";

/**
 * The sidebar carries an entry per integration in use or waiting on an admin
 * (switched off, failing), so the chrome needs that list on every screen and
 * this is the only place it is read.
 *
 * It fails soft on purpose. A worker that does not answer leaves the core
 * groups standing and the Integrations page reachable, which is where an admin
 * would go to find out why; a cockpit that refused to render because a list of
 * plugins could not be read would be the worse failure by a distance.
 */
async function cockpitIntegrations(): Promise<{
  integrations: readonly CockpitIntegration[];
  version: string | null;
}> {
  const list = await readIntegrationsList();
  const integrations = (list?.integrations ?? []).map((integration) => ({
    id: integration.id,
    name: integration.name,
    pages: integration.pages,
    // The resolver's own answers, passed as they are: the sidebar decides
    // from them which integrations get an entry, and derives none of them.
    usable: integration.state.usable,
    status: integration.state.status,
    connection: integration.state.connection,
  }));
  // What the shell compares against when a tab with unsaved work comes back
  // into focus; none when the list could not be read.
  return { integrations, version: list ? integrationsFingerprint(list.integrations) : null };
}

export default async function CockpitLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  const { integrations, version } = await cockpitIntegrations();
  return (
    <CockpitShell session={session} integrations={integrations} integrationsVersion={version}>
      {children}
    </CockpitShell>
  );
}
