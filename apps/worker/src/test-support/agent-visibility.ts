/**
 * Rows the agent visibility read model reads, seeded the way the code that
 * writes them will write them.
 *
 * STAGE 3b IS NOT IN THIS WORKTREE, so nothing here was produced by the real
 * capture path. What these helpers do instead is refuse to hand-build a stored
 * shape: a briefing goes through `recordAgentBriefing`, which is the same
 * function the send steps will call, so the index under test is whatever the
 * frozen package's builder makes of a send rather than whatever a fixture
 * author imagined. A run, its graph and its attempt rows go through the replay
 * store for the same reason.
 */
import { eq } from "drizzle-orm";
import type {
  ReplayAttemptOutcome,
  ReplayAttemptState,
  WorkflowReplayGraphSnapshot,
  WorkScopeAskedRepository,
} from "@shared/contracts";
import type { AgentBriefingBuildInput } from "@shared/agent-visibility";
import { DEFAULT_MODELS } from "@shared/harness";

import type { Db } from "../db/types.js";
import {
  clarificationRequests,
  organization,
  workflowBlockAttempts,
  workflowDefinitionVersions,
  workflowDefinitions,
  workflowRuns,
  workScopeTrail,
} from "../db/schema.js";
import { captureRunObservationStart } from "../db/repositories/runs/run-observability.js";
import { sanitizeReplayValue } from "../run-observability/sanitizer.js";
import { recordAgentBriefing } from "../run-observability/agent-briefings.js";
import {
  createVisibilityDetector,
  VisibilityCaptureRefusal,
} from "../run-observability/visibility-detector.js";
import type { VisibilitySanitizer } from "@shared/agent-visibility";

export const VISIBILITY_ORG = "org-visibility";
export const OTHER_ORG = "org-elsewhere";
export const CAPTURED_AT = new Date("2026-09-19T10:15:00.000Z");
/** Far enough ahead that a fixture is never accidentally expired by the clock
 *  of the machine the suite runs on. */
const REPLAY_EXPIRES_AT = new Date("2099-01-01T00:00:00.000Z");

/** The detector with no configured secrets: credential SHAPES are still found,
 *  which is what makes stored text a fixed point of MCP's sanitizer. */
export const detector = createVisibilityDetector({ secrets: [] });

export interface SeededWorld {
  definitionId: number;
}

/** The organizations and the workflow definition every run below hangs off. */
export async function seedVisibilityWorld(db: Db): Promise<SeededWorld> {
  await db.insert(organization).values([
    { id: VISIBILITY_ORG, name: "Visibility", slug: "visibility" },
    { id: OTHER_ORG, name: "Elsewhere", slug: "elsewhere" },
  ]);
  const [definition] = await db
    .insert(workflowDefinitions)
    .values({ name: "Visibility workflow", createdById: "admin", createdByLabel: "Admin" })
    .returning({ id: workflowDefinitions.id });
  await db.insert(workflowDefinitionVersions).values({
    definitionId: definition!.id,
    version: 1,
    definition: { schemaVersion: 2, nodes: [], edges: [] },
    createdById: "admin",
    createdByLabel: "Admin",
  });
  return { definitionId: definition!.id };
}

export interface SeedRunInput {
  runId: string;
  world: SeededWorld;
  organizationId?: string;
  /** Written on the run row itself, which is what a read from the DEFINITION
   *  end joins on. Left out, the run belongs to the seeded definition. */
  definitionId?: number | null;
  definitionVersion?: number;
  status?: string;
  statusReason?: string | null;
  /** node id -> block type, as the run's own captured graph holds it. */
  nodes?: Record<string, string>;
  /** False leaves the run with no observation at all, which is what a run
   *  whose replay was swept and a run whose capture failed both look like. */
  observed?: boolean;
  replayExpiresAt?: Date;
}

/** A run row, and (unless `observed: false`) the replay observation that
 *  carries its graph and lets its attempt rows exist at all. */
export async function seedRun(db: Db, input: SeedRunInput): Promise<void> {
  const organizationId = input.organizationId ?? VISIBILITY_ORG;
  await db.insert(workflowRuns).values({
    runId: input.runId,
    status: input.status ?? "running",
    definitionId: input.definitionId === undefined ? input.world.definitionId : input.definitionId,
    definitionVersion: input.definitionVersion ?? 1,
    ...(input.statusReason === undefined ? {} : { statusReason: input.statusReason }),
  });
  if (input.observed === false) return;
  const graph: WorkflowReplayGraphSnapshot = {
    nodes: Object.entries(input.nodes ?? { planning: "planning_agent" }).map(([id, type], at) => ({
      id,
      type: type as WorkflowReplayGraphSnapshot["nodes"][number]["type"],
      name: id,
      x: at * 100,
      y: 0,
    })),
    edges: [],
  };
  await captureRunObservationStart({
    db,
    runId: input.runId,
    organizationId,
    definitionId: input.world.definitionId,
    definitionVersion: 1,
    definitionSchemaVersion: 2,
    graph,
    layout: { nodes: {}, edges: {} },
    runtimeManifest: sanitizeReplayValue({ profile: "system-codex" }),
    now: CAPTURED_AT,
  });
  // The store sets its own retention from `now`, which a fixture pinned to a
  // past date would leave already expired; this is the one field a test needs
  // to decide for itself.
  await db
    .update(workflowRuns)
    .set({ replayExpiresAt: input.replayExpiresAt ?? REPLAY_EXPIRES_AT })
    .where(eq(workflowRuns.runId, input.runId));
}

/**
 * The nodes the editor shows for the seeded definition: version 1's graph, and
 * that version marked deployed so a read with no draft still finds them.
 *
 * Written through the ordinary tables in the stored shape, because the reader
 * parses what it reads and a hand-made shape would be rejected there rather
 * than here.
 */
export async function seedDefinitionNodes(
  db: Db,
  world: SeededWorld,
  nodes: readonly { id: string; type: string }[],
): Promise<void> {
  await db
    .update(workflowDefinitionVersions)
    .set({
      definition: {
        schemaVersion: 2,
        nodes: nodes.map((node, at) => ({
          id: node.id,
          type: node.type,
          x: at * 100,
          y: 0,
          configuration: {},
          inputs: {},
          additionalInputs: [],
        })),
        edges: [],
      } as never,
    })
    .where(eq(workflowDefinitionVersions.definitionId, world.definitionId));
  await db
    .update(workflowDefinitions)
    .set({ deployedVersion: 1 })
    .where(eq(workflowDefinitions.id, world.definitionId));
}

export interface SeedAttemptInput {
  runId: string;
  nodeId: string;
  attempt?: number;
  activationScopeId?: string;
  organizationId?: string;
  state?: ReplayAttemptState;
  outcome?: ReplayAttemptOutcome | null;
  startedAt?: Date;
  completedAt?: Date | null;
}

/**
 * One Block Attempt row.
 *
 * Written straight to the table rather than through the runtime hooks: those
 * need a live workflow invocation, and what this read model reads is the row.
 * The table's own completion check is honoured, so a state and a completion
 * time that could not coexist in production cannot be seeded here either.
 */
export async function seedAttempt(db: Db, input: SeedAttemptInput): Promise<void> {
  const state = input.state ?? "completed";
  const live = state === "running" || state === "waiting_loop";
  const startedAt = input.startedAt ?? CAPTURED_AT;
  await db.insert(workflowBlockAttempts).values({
    runId: input.runId,
    organizationId: input.organizationId ?? VISIBILITY_ORG,
    nodeId: input.nodeId,
    attempt: input.attempt ?? 1,
    activationScopeId: input.activationScopeId ?? "root",
    state,
    outcome: input.outcome ?? null,
    startedAt,
    completedAt: live ? null : (input.completedAt ?? new Date(startedAt.getTime() + 1_000)),
  });
}

export interface BriefingFixture {
  runId: string;
  nodeId?: string;
  attempt?: number;
  activationScopeId?: string;
  sequence?: number;
  /** When the send happened. Fixed unless a test is about which send is NEWER. */
  capturedAt?: Date;
  kind?: "discovery" | "agent" | "llm";
  blockType?: string;
  sections?: AgentBriefingBuildInput["sections"];
  repositoryContext?: AgentBriefingBuildInput["repositoryContext"];
  unresolvedSources?: AgentBriefingBuildInput["unresolvedSources"];
}

/**
 * One send, as the capture path will describe it.
 *
 * EVERY OPTIONAL FIELD IS LEFT OUT, not set to undefined: MCP turns an explicit
 * `undefined` into `null` on the way out while HTTP drops the key, and the
 * frozen schemas refuse null for the 36 fields that are optional. A fixture
 * that filled them in could not catch that.
 */
function briefingInput(fixture: BriefingFixture): AgentBriefingBuildInput {
  return {
    identity: {
      runId: fixture.runId,
      nodeId: fixture.nodeId ?? "planning",
      attempt: fixture.attempt ?? 1,
      activationScopeId: fixture.activationScopeId ?? "root",
      sequence: fixture.sequence ?? 1,
      kind: fixture.kind ?? "agent",
      blockType: fixture.blockType ?? "planning_agent",
      capturedAt: (fixture.capturedAt ?? CAPTURED_AT).toISOString(),
    },
    harness: { provider: "claude", model: DEFAULT_MODELS.claude },
    sections: fixture.sections ?? [
      { kind: "runtime", title: "Runtime data", text: "AWP-235: the checkout button does nothing." },
      { kind: "block", title: "Block role", text: "Plan the change." },
    ],
    repositoryContext: fixture.repositoryContext ?? null,
    ...(fixture.unresolvedSources === undefined
      ? {}
      : { unresolvedSources: fixture.unresolvedSources }),
  };
}

/**
 * A detector that cannot prove what it would store is clean.
 *
 * The real one raises this when a credential survives its own removals, which
 * is what makes capture write a `capture_skipped` marker with a reason instead
 * of a briefing. No fixture can reach that state by content alone, so the
 * refusal is injected.
 */
const CAPTURE_REFUSAL =
  "after 8 rounds the capture detector still found a credential in what it would store";

const refusingDetector: VisibilitySanitizer = (text) => {
  // Its own one-line reason passes, which is what lets capture store a sentence
  // a reader can be shown. A detector broken for every text has that sentence
  // replaced by capture's fallback, which is a different, quieter marker.
  if (text === CAPTURE_REFUSAL) return detector(text);
  throw new VisibilityCaptureRefusal(CAPTURE_REFUSAL);
};

/** Records one send through the real write path. `capture: false` writes the
 *  marker row that says capture was switched off when this send happened;
 *  `refuse: true` writes the marker that says the record was refused. */
export function captureBriefing(
  db: Db,
  fixture: BriefingFixture,
  options: { capture?: boolean; refuse?: boolean } = {},
) {
  return recordAgentBriefing(briefingInput(fixture), {
    db,
    sanitize: options.refuse === true ? refusingDetector : detector,
    ...(options.capture === undefined ? {} : { capture: options.capture }),
  });
}

export interface SeedClarificationInput {
  id: string;
  runId: string;
  subjectKey: string;
  questions: string[];
  askedAt: Date;
  status?: string;
  nodeId?: string | null;
  offered?: WorkScopeAskedRepository[] | null;
}

export async function seedClarification(db: Db, input: SeedClarificationInput): Promise<void> {
  await db.insert(clarificationRequests).values({
    id: input.id,
    runId: input.runId,
    subjectKey: input.subjectKey,
    blockId: input.nodeId ?? "ask",
    questions: input.questions,
    askedAt: input.askedAt,
    status: input.status ?? "answered",
    ...(input.offered === undefined ? {} : { askedRepositories: input.offered }),
  });
}

export async function seedTrailEvent(
  db: Db,
  input: { subjectKey: string; runId: string; kind: string; event: Record<string, unknown>; at: Date },
): Promise<void> {
  await db.insert(workScopeTrail).values({
    subjectKey: input.subjectKey,
    runId: input.runId,
    kind: input.kind as never,
    event: input.event as never,
    at: input.at,
  });
}
