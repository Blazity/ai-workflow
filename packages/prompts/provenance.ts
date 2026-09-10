import type {
  PromptLibraryListRowDto,
  PromptSourceRef,
  WorkflowDefinitionNode,
} from "@shared/contracts";
import { fnv1a } from "./hash";

/** The provenance ref stored under a node's param key, or null when absent. */
export function getPromptRef(
  node: Pick<WorkflowDefinitionNode, "promptRefs">,
  paramKey: string,
): PromptSourceRef | null {
  return node.promptRefs?.[paramKey] ?? null;
}

/** Build a ref at insert time, fingerprinting the inserted text so a later
 *  manual edit of the field can be detected. */
export function makePromptRef(
  promptId: number,
  version: number,
  insertedText: string,
): PromptSourceRef {
  return { promptId, version, insertedHash: fnv1a(insertedText) };
}

export type DriftState =
  | { kind: "current"; row: PromptLibraryListRowDto }
  | { kind: "behind"; row: PromptLibraryListRowDto; latest: number }
  | { kind: "edited"; row: PromptLibraryListRowDto }
  | { kind: "archived"; row: PromptLibraryListRowDto }
  | { kind: "missing" };

/** Compare a stored ref against the current library rows. Precedence:
 *  missing > archived > behind > edited > current. */
export function driftFor(
  ref: PromptSourceRef,
  currentText: string,
  rows: readonly PromptLibraryListRowDto[],
): DriftState {
  const row = rows.find((r) => r.id === ref.promptId);
  if (!row) return { kind: "missing" };
  if (row.archivedAt !== null) return { kind: "archived", row };
  if (row.currentVersion > ref.version) {
    return { kind: "behind", row, latest: row.currentVersion };
  }
  if (ref.insertedHash !== undefined && fnv1a(currentText) !== ref.insertedHash) {
    return { kind: "edited", row };
  }
  return { kind: "current", row };
}
