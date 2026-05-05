import type { RunRegistryAdapter } from "../../adapters/run-registry/types.js";
import { isClaimingSentinel } from "../dispatch.js";
import { formatRunList, formatRunStatus } from "./format.js";

export type CancelRunFn = (
  ticketKey: string,
  runId: string,
  registry: RunRegistryAdapter,
) => Promise<boolean>;

export type StopTicketSandboxesFn = (
  ticketKey: string,
  sandboxId: string | null,
) => Promise<unknown>;

export async function handleList(
  registry: RunRegistryAdapter,
  jiraBaseUrl: string,
): Promise<string> {
  const all = await registry.listAll();
  const live = all.filter((row) => !isClaimingSentinel(row.runId));
  return formatRunList(live, jiraBaseUrl);
}

export async function handleStatus(
  registry: RunRegistryAdapter,
  ticketKey: string,
  jiraBaseUrl: string,
): Promise<string> {
  const [runId, sandboxId] = await Promise.all([
    registry.getRunId(ticketKey),
    registry.getSandboxId(ticketKey),
  ]);
  return formatRunStatus(ticketKey, { runId, sandboxId }, jiraBaseUrl);
}

export async function handleCancel(
  registry: RunRegistryAdapter,
  ticketKey: string,
  cancelRunFn: CancelRunFn,
  stopSandboxes: StopTicketSandboxesFn,
): Promise<string> {
  const runId = await registry.getRunId(ticketKey);
  if (!runId) return `No active run for ${ticketKey}.`;

  if (isClaimingSentinel(runId)) {
    // Mid-dispatch: dispatch.ts has called start() but not yet swapped in the
    // real runId. We can't cancel a workflow whose id we don't know. Stop any
    // sandbox that may have leaked and clear the entry so the next dispatch
    // sees a clean slot — same shape as the jira webhook handles it.
    const sandboxId = await registry.getSandboxId(ticketKey).catch(() => null);
    await stopSandboxes(ticketKey, sandboxId).catch(() => {});
    await registry.unregister(ticketKey).catch(() => {});
    return `${ticketKey} is mid-dispatch; cleared the claim. Try the cancel again in a moment if a real run shows up.`;
  }

  const ok = await cancelRunFn(ticketKey, runId, registry);
  if (ok) return `Cancelled ${ticketKey} (runId \`${runId}\`).`;
  return `${ticketKey}: could not cancel run \`${runId}\` cleanly — sandbox + registry have been cleaned up.`;
}
