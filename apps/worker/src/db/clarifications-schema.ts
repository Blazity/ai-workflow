import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { BlockOutput, WorkflowBlockType } from "@shared/contracts";
import type {
  InterpreterControlState,
  StepsRecord,
} from "../workflow-definition/interpreter.js";
import type {
  ClarificationOriginEntry,
  WorkflowDefinitionVersionPin,
} from "../workflows/agent-input.js";
import type { RunBudgetState } from "../workflows/run-budget.js";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";
import type { AgentKind } from "../sandbox/agents/index.js";
import type { PhaseUsage } from "../sandbox/agents/types.js";
import type { HumanDecision } from "../lib/human-decisions-memory.js";
import type { PreSandboxPromptAdditionsByTarget } from "../pre-sandbox/types.js";
import type { WorkspacePublicationResult } from "../workflows/workspace-publication.js";

export interface ClarificationSourceHead {
  provider: "github" | "gitlab";
  repoPath: string;
  sha: string;
}

export interface ClarificationRuntimeContext {
  preSandboxAdditions: PreSandboxPromptAdditionsByTarget;
  /** Optional for checkpoints written before durable continuation state expanded. */
  implementationKind?: AgentKind | null;
  implementationModel?: string | null;
  publication?: WorkspacePublicationResult | null;
  clarifications?: HumanDecision[];
  phaseUsages?: Record<string, PhaseUsage | null>;
  phaseModels?: Record<string, string>;
  activeModel?: string | null;
  prForTelemetry?: { url: string; number: number } | null;
}

/**
 * Clarification queue: one row per set of questions a run parked on because the
 * agent needed human input before it could continue. The run records status
 * "awaiting" and inserts a pending row; the dashboard lists pending rows and
 * posts an answer, which dispatches a fresh clarification_answered resume run.
 *
 * The partial unique index keeps at most one pending row per subject, and it is
 * the only thing that can: this deployment uses the neon-http driver, which has
 * no interactive transactions, so createClarificationRequest supersedes the
 * current pending row and then inserts the new one as two separate statements.
 * The index is what still guarantees a re-pickup of the same ticket can never
 * leave two live clarifications competing for one resume. Do not "restore" a
 * transaction here: it passes the pglite tests and fails in production.
 */
export const clarificationRequests = pgTable(
  "clarification_requests",
  {
    id: text("id").primaryKey(),
    ticketKey: text("ticket_key"),
    /** Run that asked the questions. */
    runId: text("run_id").notNull(),
    /** Graph node that raised the questions; null for the built-in default graph. */
    blockId: text("block_id"),
    /**
     * Definition the asking run belonged to. Nullable because clarifications can
     * come from the built-in default definition, which has no stored row.
     */
    definitionId: integer("definition_id"),
    /** Head version of that definition when the questions were filed. */
    definitionVersion: integer("definition_version"),
    questions: jsonb("questions").$type<string[]>().notNull(),
    suggestedAnswers: jsonb("suggested_answers").$type<string[]>(),
    status: text("status").notNull().default("pending"),
    askedAt: timestamp("asked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    answer: text("answer"),
    answeredById: text("answered_by_id"),
    answeredByLabel: text("answered_by_label"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    /** Resume run started when the questions were answered (the clarification_answered run). */
    dispatchedRunId: text("dispatched_run_id"),
    /** Provider-neutral owner-CAS subject retained by the parked run. */
    subjectKey: text("subject_key"),
    /** Exact owner token of the parked, bound predecessor. */
    ownerToken: text("owner_token"),
    /** Node that must be rerun on resume; predecessors are represented by priorSteps. */
    waitingNodeId: text("waiting_node_id"),
    /** Includes the built-in fallback sentinel, which cannot fit the legacy integer column. */
    definitionVersionPin: jsonb("definition_version_pin").$type<WorkflowDefinitionVersionPin>(),
    originEntry: jsonb("origin_entry").$type<ClarificationOriginEntry>(),
    originTriggerNodeId: text("origin_trigger_node_id"),
    originTriggerType: text("origin_trigger_type").$type<WorkflowBlockType>(),
    triggerPayload: jsonb("trigger_payload").$type<BlockOutput>(),
    priorSteps: jsonb("prior_steps").$type<StepsRecord>(),
    interpreterState: jsonb("interpreter_state").$type<InterpreterControlState>(),
    budgetState: jsonb("budget_state").$type<RunBudgetState>(),
    runtimeContext: jsonb("runtime_context").$type<ClarificationRuntimeContext>(),
    workspaceManifest: jsonb("workspace_manifest").$type<WorkspaceManifest>(),
    sourceHeads: jsonb("source_heads").$type<ClarificationSourceHead[]>(),
    /** preparing -> ready -> expired/orphaned; status remains the public answer lifecycle. */
    checkpointState: text("checkpoint_state"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    snapshotId: text("snapshot_id"),
    sourceSandboxId: text("source_sandbox_id"),
    snapshotRequestedAt: timestamp("snapshot_requested_at", { withTimezone: true }),
    snapshotExpiresAt: timestamp("snapshot_expires_at", { withTimezone: true }),
    cleanupState: text("cleanup_state").notNull().default("none"),
    cleanupError: text("cleanup_error"),
    cleanupClaimedAt: timestamp("cleanup_claimed_at", { withTimezone: true }),
    successorOwnerToken: text("successor_owner_token"),
    successorReservedAt: timestamp("successor_reserved_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    index("clarification_requests_status_idx").on(t.status),
    index("clarification_requests_ticket_key_idx").on(t.ticketKey),
    index("clarification_requests_run_id_idx").on(t.runId),
    index("clarification_requests_checkpoint_expiry_idx").on(t.checkpointState, t.expiresAt),
    index("clarification_requests_cleanup_idx").on(t.cleanupState),
    uniqueIndex("clarification_requests_pending_subject_idx")
      .on(t.subjectKey)
      .where(sql`${t.status} = 'pending'`),
  ],
);
