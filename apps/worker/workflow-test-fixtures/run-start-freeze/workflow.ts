import { sleep } from "workflow";
import type { ProbeRepositoryAccess } from "./store.js";

/**
 * The shape of the engine's run start, reduced to the one property that matters:
 * a run finishes under the repository access it started with.
 *
 * `engine/steps/run-start-settings.ts` reads the catalog once, before every
 * other step, and the workflow body hands the value down. The claim that makes
 * that safe is a claim about the Workflow journal: a run suspended across an
 * operator's edit replays the RECORDED result of that step rather than reading
 * the store again. This fixture exercises exactly that claim against the real
 * runtime, with a file standing in for the catalog.
 */
async function loadRunStartAccessStep(): Promise<ProbeRepositoryAccess> {
  "use step";
  const { readAccess, recordLoad } = await import("./store.js");
  recordLoad();
  return readAccess();
}

/** Reads the store again, after the suspension, so the test can prove the store
 *  really moved. Without this control a frozen value proves nothing. */
async function observeAccessStep(frozen: ProbeRepositoryAccess): Promise<{
  frozen: ProbeRepositoryAccess;
  live: ProbeRepositoryAccess;
}> {
  "use step";
  const { readAccess } = await import("./store.js");
  return { frozen, live: readAccess() };
}

export interface RunStartFreezeInput {
  /** Long enough for the test to edit the store while the run is suspended. */
  sleepMs: number;
}

export async function probeRunStartFreeze(input: RunStartFreezeInput): Promise<{
  frozen: ProbeRepositoryAccess;
  live: ProbeRepositoryAccess;
}> {
  "use workflow";
  const frozen = await loadRunStartAccessStep();
  await sleep(`${input.sleepMs}ms`);
  return await observeAccessStep(frozen);
}
