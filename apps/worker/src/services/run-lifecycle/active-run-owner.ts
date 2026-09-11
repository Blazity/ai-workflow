import type { Db } from "../../db/types.js";
import {
  assertActiveRunOwnerState as assertOwnerState,
  assertConnectedActiveRunOwner as assertConnected,
} from "../../db/repositories/active-runs.js";
export { ActiveRunOwnerError } from "./run-control-errors.js";

export interface ActiveRunOwner {
  subjectKey: string;
  ownerToken: string;
  runId: string | null;
}

/**
 * Reassert the exact owner at an irreversible provider boundary. Bound runs
 * must still own the same Workflow id; pre-start paths must still own their
 * exact reservation. Cancellation changes either state to cancelling, which
 * closes this fence before the provider is called.
 */
export async function assertActiveRunOwner(
  db: Db,
  owner: ActiveRunOwner,
): Promise<void> {
  await assertActiveRunOwnerState(
    db,
    owner,
    owner.runId === null ? "reserved" : "bound",
  );
}

export function assertConnectedActiveRunOwner(owner: ActiveRunOwner): Promise<void> {
  return assertConnected(owner);
}

export function assertConnectedActiveRunOwnerState(
  owner: ActiveRunOwner,
  state: "reserved" | "bound" | "parked" | "cancelling",
): Promise<void> {
  return assertOwnerState(owner, state);
}

export function assertActiveRunOwnerState(
  db: Db,
  owner: ActiveRunOwner,
  state: "reserved" | "bound" | "parked" | "cancelling",
): Promise<void> {
  return assertOwnerState(owner, state, db);
}
