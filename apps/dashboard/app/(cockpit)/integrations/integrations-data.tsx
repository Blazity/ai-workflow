import { canManageIntegrations } from "@shared/contracts";
import type {
  IntegrationCapabilitiesResponse,
  WorkflowDefinitionsResponse,
} from "@shared/contracts";

import { authAwareFallback, getJSON } from "@/lib/api/server";
import { requireSession } from "@/lib/auth/session";
import { readIntegrationsList } from "@/lib/integrations/list";
import { blockAvailabilityOf } from "@/lib/integrations/presentation";

import { IntegrationsScreen } from "./integrations-screen";

/**
 * Reading which integrations are connected is open to every role, so this page
 * is not role gated; only the controls on the connection screen are, and the
 * worker is what enforces that. A member who could not see this list could not
 * tell a deployment that is quiet from one that is broken.
 *
 * The second read is the editor's block registry, which is the only place that
 * knows whether this build can actually run a block an integration declares:
 * the card promised two blocks while the palette refused one of them, and a
 * promise a colleague cannot keep is worse than no promise. It is the same
 * endpoint the editor uses, because the worker ships no lighter one; it runs in
 * parallel with the integrations read, and a deployment that refuses it (a
 * role, a worker that did not answer) leaves the card describing the blocks
 * instead of promising them.
 *
 * The third read says which provider serves each capability, the built-in one
 * included. It is its own endpoint rather than part of the list because the
 * list is read on every cockpit page for the sidebar, and this answer is only
 * wanted here. A worker that does not answer it (or one a deploy behind that
 * does not have it yet) leaves the section saying so and the cards standing.
 */
export async function IntegrationsData() {
  const session = await requireSession();

  const [list, editor, capabilities] = await Promise.all([
    readIntegrationsList(),
    getJSON<WorkflowDefinitionsResponse>("/api/v1/workflow-definitions").catch((error) =>
      authAwareFallback(error, (): WorkflowDefinitionsResponse | null => null),
    ),
    getJSON<IntegrationCapabilitiesResponse>("/api/v1/integrations/capabilities").catch((error) =>
      authAwareFallback(error, (): IntegrationCapabilitiesResponse | null => null),
    ),
  ]);

  const integrations = list?.integrations ?? [];

  return (
    <IntegrationsScreen
      integrations={integrations}
      writes={list?.writes ?? { allowed: true }}
      canManage={canManageIntegrations(session.role)}
      available={list !== null}
      availability={
        editor ? blockAvailabilityOf(editor.options.blockRegistry, integrations) : undefined
      }
      capabilities={capabilities?.capabilities ?? null}
    />
  );
}
