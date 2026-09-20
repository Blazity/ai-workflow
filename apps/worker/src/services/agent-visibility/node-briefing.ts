/**
 * What one block of a workflow last put in front of a model.
 *
 * The question an operator editing a definition asks is not "show me run 412",
 * it is "what does THIS block actually send". So this read starts at the node
 * and finds the run, rather than the other way round, and then hands back the
 * very same attempt the run view shows: one shape, one renderer, one
 * vocabulary for why something is not here.
 *
 * ACROSS VERSIONS, DELIBERATELY. An operator asking what a block sends does not
 * care that the definition was bumped since; they care what went out. So the
 * newest run of any version wins and the version it ran is said out loud, which
 * is also the warning the operator needs: the briefing below came from a
 * definition that is not the one on their canvas.
 *
 * A NODE THE DEFINITION NO LONGER HAS is answered from the runs anyway. Runs
 * carry their own graph, the history is real, and refusing would hide it behind
 * an edit that has nothing to do with it. `blockType` is null in that case, and
 * a node neither the definition nor any run has is simply one that never ran.
 */
import { AGENT_VISIBILITY_SCHEMA_VERSION, shortenVisibilityId } from "@shared/agent-visibility";
import {
  readConnectedNodeLastRunRow,
  readNodeLastRunRow,
  type NodeLastRunRow,
} from "../../db/repositories/agent-visibility.js";
import type { Db } from "../../db/types.js";
import {
  PROMPT_SENDING_BLOCK_TYPES,
  readBriefingAttempts,
  type BlockAttemptBriefings,
  type BriefingReads,
  type PageBounds,
  type RunBriefingState,
  type RunCaptureCounts,
} from "./briefing-read.js";
import { notFound } from "./pages.js";
import { getConnectedWorkflowDefinitionName } from "../../db/repositories/definitions/connected.js";
import { getWorkflowDefinitionName } from "../../db/repositories/definitions/operations.js";
import {
  readConnectedWorkflowDefinitionDraft,
  readWorkflowDefinitionDraft,
} from "../../engine/definition-draft-read.js";
import {
  readConnectedDeployedWorkflowDefinitionVersion,
  readDeployedWorkflowDefinitionVersion,
} from "../../engine/stored-definition-reads.js";

/** The node, as the definition an operator is editing has it. */
interface DefinitionNode {
  nodeId: string;
  blockType: string;
}

export interface NodeBriefingReads extends BriefingReads {
  /** Whether the id names a definition at all. Asked separately from its nodes
   *  because a definition with no graph yet is a real definition, and telling a
   *  caller "this node never ran" about an id that does not exist sends them
   *  looking for a run rather than for their typo. */
  definitionExists(definitionId: number): Promise<boolean>;
  /** The nodes of the definition as the editor shows them: its draft when it
   *  has one, else its deployed version. Empty for a definition with neither. */
  definitionNodes(definitionId: number): Promise<DefinitionNode[]>;
  lastRun(input: {
    definitionId: number;
    nodeId: string;
    storedNodeId: string;
    organizationId: string;
  }): Promise<NodeLastRunRow | null>;
}

/**
 * Why there is no briefing to show, where no run can say it.
 *
 * Both answers are about the BLOCK rather than about a send, which is why they
 * are not the frozen `MissingBriefingReason`: that vocabulary answers "why has
 * this attempt no briefing", and here there may be no attempt at all.
 */
export type NodeBriefingAbsence =
  | { kind: "never_ran" }
  | { kind: "sends_no_prompt" };

export interface NodeLastBriefing {
  schemaVersion: typeof AGENT_VISIBILITY_SCHEMA_VERSION;
  definitionId: number;
  /** As the caller named it, which is how the definition spells it. */
  nodeId: string;
  /** From the definition being edited, null when the node is not in it. */
  blockType: string | null;
  /** False for a block that puts no prompt in front of a model, null where
   *  nothing left can say: the node is not in the definition and no run of it
   *  recorded what kind of send it made. */
  sendsPrompts: boolean | null;
  /** The newest run of this definition that this node left a trace in. */
  ranIn: {
    runId: string;
    /** The definition version that ran, which may not be the one being edited. */
    definitionVersion: number | null;
    at: string;
    state: RunBriefingState;
    capture: RunCaptureCounts | null;
  } | null;
  /** That run's newest attempt of this node, in the shape the run view uses:
   *  its briefings, and `missing` where one is not here. */
  attempt: BlockAttemptBriefings | null;
  /** Set only where `ranIn` is null: nothing ran, or nothing was ever going to
   *  be sent. Null whenever the run itself can answer. */
  absent: NodeBriefingAbsence | null;
}

export function nodeBriefingReadsOf(db: Db, reads: BriefingReads): NodeBriefingReads {
  return {
    ...reads,
    definitionExists: async (definitionId) =>
      (await getWorkflowDefinitionName(db, definitionId)) !== null,
    definitionNodes: (definitionId) => definitionNodesOf(definitionId, db),
    lastRun: (input) => readNodeLastRunRow(db, input),
  };
}

export function connectedNodeBriefingReadsOf(reads: BriefingReads): NodeBriefingReads {
  return {
    ...reads,
    definitionExists: async (definitionId) =>
      (await getConnectedWorkflowDefinitionName(definitionId)) !== null,
    definitionNodes: (definitionId) => definitionNodesOf(definitionId),
    lastRun: readConnectedNodeLastRunRow,
  };
}

/** The editor's own nodes: its draft where there is one, else what is deployed.
 *  Read through the definition store, which is what the editor reads. */
async function definitionNodesOf(definitionId: number, db?: Db): Promise<DefinitionNode[]> {
  const draft = db
    ? await readWorkflowDefinitionDraft(db, definitionId)
    : await readConnectedWorkflowDefinitionDraft(definitionId);
  const deployed = db
    ? await readDeployedWorkflowDefinitionVersion(db, definitionId)
    : await readConnectedDeployedWorkflowDefinitionVersion(definitionId);
  const shown = draft?.draft ?? deployed?.definition;
  const nodes = (shown as { nodes?: { id?: unknown; type?: unknown }[] } | undefined)?.nodes ?? [];
  return nodes.flatMap((node) =>
    typeof node.id === "string" && typeof node.type === "string"
      ? [{ nodeId: node.id, blockType: node.type }]
      : [],
  );
}

export interface ReadNodeLastBriefingInput {
  definitionId: number;
  nodeId: string;
  organizationId: string;
  now?: Date;
  bounds?: PageBounds;
}

/**
 * The newest briefing this node produced, or the reason there is none.
 *
 * The run is found first and then read through the ordinary attempts read, so
 * the tenant rule, the missing-reason vocabulary and the page bounds are the
 * ones every other view of a briefing already uses.
 */
export async function readNodeLastBriefing(
  reads: NodeBriefingReads,
  input: ReadNodeLastBriefingInput,
): Promise<NodeLastBriefing> {
  const [exists, nodes, lastRun] = await Promise.all([
    reads.definitionExists(input.definitionId),
    reads.definitionNodes(input.definitionId),
    reads.lastRun({
      definitionId: input.definitionId,
      nodeId: input.nodeId,
      storedNodeId: shortenVisibilityId(input.nodeId),
      organizationId: input.organizationId,
    }),
  ]);
  // A definition nobody has is not a node that never ran: said plainly, so a
  // caller looks at the id it passed rather than at the run history.
  if (!exists) {
    throw notFound(`There is no workflow definition ${input.definitionId} you may read.`);
  }
  const blockType = nodes.find((node) => node.nodeId === input.nodeId)?.blockType ?? null;
  const answer = {
    schemaVersion: AGENT_VISIBILITY_SCHEMA_VERSION,
    definitionId: input.definitionId,
    nodeId: input.nodeId,
    blockType,
  };

  if (lastRun === null) {
    // Nothing ran it. A block that was never going to send anything is told
    // apart from one that simply has not run yet, because they are different
    // things to do about it: nothing, versus dispatch the workflow.
    const sends = blockType === null ? null : PROMPT_SENDING_BLOCK_TYPES.has(blockType);
    return {
      ...answer,
      sendsPrompts: sends,
      ranIn: null,
      attempt: null,
      absent: sends === false ? { kind: "sends_no_prompt" } : { kind: "never_ran" },
    };
  }
  // A run whose trace recorded no organization is NOT filtered out of the
  // candidates above, so that the read below refuses out loud instead of
  // answering "this node never ran" about a run that plainly did. The refusal
  // itself belongs to `readBriefingAttempts`, which is where every other read
  // of a run gets it: one tenant rule, in one place.

  const page = await readBriefingAttempts(reads, {
    runId: lastRun.runId,
    organizationId: input.organizationId,
    nodeId: input.nodeId,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.bounds === undefined ? {} : { bounds: input.bounds }),
  });
  // The attempts of one node in one run, oldest first: the last one is the
  // newest try, which is the one an operator means by "last time it ran".
  const attempt = page.items.at(-1) ?? null;
  return {
    ...answer,
    sendsPrompts: attempt?.sendsPrompts ?? (blockType === null ? null : PROMPT_SENDING_BLOCK_TYPES.has(blockType)),
    ranIn: {
      runId: lastRun.runId,
      definitionVersion: lastRun.definitionVersion,
      at: lastRun.at.toISOString(),
      state: page.state,
      capture: page.capture,
    },
    attempt,
    absent: null,
  };
}

