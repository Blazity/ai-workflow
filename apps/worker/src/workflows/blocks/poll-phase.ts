/**
 * Wait for an agent phase's sentinel file, polling every 30s up to maxMinutes.
 * Returns false when the phase stopped without finishing or the cap ran out.
 * Plain async orchestration (not a "use step"): it drives the checkPhaseDone
 * step, so it is safe to share between block executors.
 */
export async function pollPhaseUntilDone(
  sandboxId: string,
  sentinelFile: string,
  maxMinutes: number,
): Promise<boolean> {
  const { sleep } = await import("workflow");
  const { checkPhaseDone } = await import("../../sandbox/poll-agent.js");
  const maxPolls = Math.ceil((maxMinutes * 60) / 30);
  for (let poll = 0; poll < maxPolls; poll++) {
    await sleep("30s");
    const status = await checkPhaseDone(sandboxId, sentinelFile);
    if (status === true) return true;
    if (status === "stopped") return false;
  }
  return false;
}
