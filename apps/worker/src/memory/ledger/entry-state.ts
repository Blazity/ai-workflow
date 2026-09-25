import type { MemoryEntryStateValues } from "../../db/repositories/memory-entry-state.js";

/** Where an entry came from, as the store port names it. */
export type MemoryEntryOriginHint = "learned" | "derived" | "imported" | "human";

/**
 * What an entry without a state row reads as: topic `other`, area
 * `unresolved`, trust `learned` (`derived` for an entry the seed derived),
 * status `active`, not pinned. Also the base a first write fills in.
 */
export function defaultMemoryEntryState(origin?: MemoryEntryOriginHint): MemoryEntryStateValues {
  return {
    storeIds: {},
    topic: "other",
    area: "unresolved",
    areaStatus: "unresolved",
    areaCandidates: [],
    module: null,
    anchors: [],
    trust: origin === "derived" ? "derived" : "learned",
    pinned: false,
    status: "active",
    statusReason: null,
    openDisputes: [],
    relearnedUnseen: 0,
    originRunId: null,
    originTicket: null,
    lastAdmittedAt: null,
  };
}
