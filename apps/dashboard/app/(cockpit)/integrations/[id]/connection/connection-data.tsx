import { canManageIntegrations } from "@shared/contracts";
import type { IntegrationsListResponse } from "@shared/contracts";

import { authAwareFallback, getJSON } from "@/lib/api/server";
import { requireSession } from "@/lib/auth/session";
import { workerUnreachableLine } from "@/lib/integrations/presentation";

import { ConnectionScreen, UnknownIntegrationScreen } from "./connection-screen";

/**
 * One integration's connection, read from the same list the cards read.
 *
 * There is no per-integration read endpoint and none is needed: the list is one
 * round trip, carries every field this screen draws, and comes from the one
 * resolver that decides a status. Asking twice would be two answers.
 */
export async function ConnectionData({ id }: { id: string }) {
  const session = await requireSession();
  const canManage = canManageIntegrations(session.role);

  const list = await getJSON<IntegrationsListResponse>("/api/v1/integrations").catch(
    (error) => authAwareFallback(error, (): IntegrationsListResponse | null => null),
  );

  if (list === null) {
    return (
      <div className="flex flex-col gap-3 px-4 lg:px-6 pt-5 pb-8 max-w-[640px]">
        <a
          href="/integrations"
          className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500 no-underline hover:underline"
        >
          &lt;- Integrations
        </a>
        <div className="rounded-[3px] border border-[#F0B8AE] bg-fail-bg px-3 py-2 font-body text-[12px] text-fail-fg">
          {workerUnreachableLine(canManage)}
        </div>
      </div>
    );
  }

  const integration = list.integrations.find((candidate) => candidate.id === id);
  if (!integration) return <UnknownIntegrationScreen id={id} />;

  return (
    <ConnectionScreen
      integration={integration}
      writes={list.writes}
      canManage={canManage}
    />
  );
}
