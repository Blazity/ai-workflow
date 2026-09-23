import { canManageIntegrations } from "@shared/contracts";

import { requireSession } from "@/lib/auth/session";
import { readIntegrationsList, readLatestHealthScan } from "@/lib/integrations/list";
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

  const [list, scan] = await Promise.all([readIntegrationsList(), readLatestHealthScan()]);

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
      scan={scan}
    />
  );
}
