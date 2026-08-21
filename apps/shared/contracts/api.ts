import type {
  ApprovalRequest,
  ClarificationRequest,
  JsonSchema202012,
  JsonValue,
  PrePrCheckConfigVersion,
  RepositoryOption,
  Run,
  RunBlockStatusSnapshot,
  RunDetail,
  RunStep,
  Workflow,
  WorkflowBlockContract,
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionLayout,
  WorkflowDefinitionV2,
  WorkflowDefinitionVersion,
  WorkflowDataReferenceV2,
  WorkflowEditorOptions,
  WorkflowValueSchema,
  VcsProviderKind,
  WebhookAuthScheme,
} from "./domain.js";
import type { PromptSlotDefinition } from "./prompt-slots.js";

export interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

export interface KpisResponse {
  generatedAt: string;
  runs24h: { value: number; deltaPct: number; spark: number[] } | null;
  p95: { valueSec: number; deltaSec: number; spark: number[] } | null;
  errors24h: { value: number; deltaPct: number; spark: number[] } | null;
  cost24h: { value: number; deltaPct: number } | null;
}

export type EvalHealthResponse =
  | {
      available: true;
      score: number;
      pass: number;
      warn: number;
      fail: number;
      spansGraded: number;
      windowHours: number;
    }
  | { available: false; reason: string };

export type EvalsResponse =
  | {
      available: true;
      generatedAt: string;
      windowHours: number;
      /** continuous_eval_success_rate × 100, fleet-wide. */
      score: number;
      /** Σ eval_count across tasks — "spans graded" in the window. */
      spansGraded: number;
      /** Σ trace_count across tasks. */
      traceCount: number;
    }
  | { available: false; generatedAt: string; reason: string };

export interface CostByWorkflowEntry {
  /** Arthur task_id (per ticket-run, e.g. "AWT-42" / "AWT-42.1"). */
  taskId: string;
  /** Arthur task name (= the ticket-run identifier). */
  name: string;
  /** trace_count for the task. */
  runs: number;
  /** trace_token_count. */
  tokens: number;
  /** trace_token_cost (USD). */
  cost: number;
  /** cost / max(1, runs). */
  costPerRun: number;
}

export interface CostResponse {
  generatedAt: string;
  /**
   * false when Arthur is unconfigured/unreachable or returns nothing. The
   * screen renders its empty/N-A state.
   */
  available: boolean;
  /** Window the figures cover (month-to-date). ISO. */
  window: { start: string; end: string };
  totals: {
    /** USD, Σ trace total_token_cost over the window. */
    totalTokenCost: number;
    /** Σ trace total_token_count over the window. */
    totalTokens: number;
    /** Number of traces in the window. */
    traceCount: number;
    /** totalTokenCost / max(1, traceCount). */
    costPerRun: number;
  };
  /** Per-task (= per ticket-run) breakdown, aggregated from the trace rows. */
  byWorkflow: CostByWorkflowEntry[];
  /** Per-day spend, oldest→newest, bucketed by trace start_time. */
  daily: { date: string; cost: number; tokens: number }[];
}

export interface LiveRunsResponse {
  generatedAt: string;
  rows: Run[];
}

/** One ticket waiting for a run slot because the pool is full (AIW-277). */
export interface QueuedTicketEntry {
  ticketKey: string;
  /** ISO-8601 first-seen timestamp — how long it has been waiting. */
  queuedAt: string;
}

/**
 * Dispatch-capacity snapshot for the Overview. `occupiedSlots` is counted the
 * way the refusal counts it (listCapacityConsumers — parked claims included),
 * so a full pool with zero executing runs no longer looks idle. `queued` lists
 * the tickets that were refused for capacity and are waiting.
 */
export interface DispatchCapacityResponse {
  generatedAt: string;
  occupiedSlots: number;
  maxSlots: number;
  queued: QueuedTicketEntry[];
}

export interface RunsResponse {
  generatedAt: string;
  available: boolean;
  rows: Run[];
  total: number;
  counts: {
    success: number;
    running: number;
    awaiting: number;
    failed: number;
    blocked: number;
  };
}

export interface TicketRunsResponse {
  generatedAt: string;
  available: boolean;
  ticket: { key: string; title: string; url: string } | null;
  runs: Run[];
  totals: {
    cost: number;
    tokens: number;
    runCount: number;
    counts: { success: number; running: number; awaiting: number; failed: number; blocked: number };
  };
}

export interface RunDetailResponse {
  generatedAt: string;
  /** `false` when the run can't be read (worker/world unavailable or unknown id). */
  available: boolean;
  run: RunDetail | null;
  steps: RunStep[];
  clarification?: ClarificationRequest | null;
}

export interface WorkflowRow extends Pick<Workflow, "id" | "name" | "blurb" | "gateway"> {
  primary?: boolean;
  runs24h: number | null;
  p50: number | null;
  p95: number | null;
  errRate: number | null;
  costToday: number | null;
  latestRun: Pick<
    Run,
    "ticket" | "ticketUrl" | "ticketTitle" | "prNumber" | "prUrl" | "prs"
  > | null;
  trend24h: number[] | null;
}

export interface WorkflowsResponse {
  generatedAt: string;
  rows: WorkflowRow[];
  total: number;
}

export interface PrePrChecksResponse {
  current: PrePrCheckConfigVersion | null;
  /** Newest first, capped at 50. */
  versions: PrePrCheckConfigVersion[];
}

export interface PrePrCheckSaveResponse {
  version: PrePrCheckConfigVersion;
}

export interface RepositoriesResponse {
  repositories: RepositoryOption[];
  providers: RepositoryProviderStatus[];
}

export interface RepositoryProviderStatus {
  provider: VcsProviderKind;
  status: "ready" | "not_connected" | "error";
  error?: string;
}

export interface WorkflowDefinitionMeta {
  id: number;
  name: string;
  enabled: boolean;
  triggerTypes: WorkflowBlockType[];
  currentVersion: number | null;
  /** Mutable semantic authoring revision. */
  draftRevision: number;
  /** Independently persisted presentation revision. */
  layoutRevision: number;
  /** Exact immutable version selected for new runs. */
  deployedVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDefinitionTemplate {
  id: string;
  name: string;
  description: string;
  definition: WorkflowDefinition;
}

export interface WorkflowDefinitionsResponse {
  definitions: WorkflowDefinitionMeta[];
  templates: WorkflowDefinitionTemplate[];
  defaultDefinition: WorkflowDefinition;
  options: WorkflowEditorOptions;
}

export interface WorkflowDefinitionDetailResponse {
  meta: WorkflowDefinitionMeta;
  /** Semantic draft with the latest layout overlaid for editing. */
  draft: WorkflowDefinition | null;
  layout: WorkflowDefinitionLayout;
  deployed: WorkflowDefinitionVersion | null;
  /** @deprecated Use `deployed`. */
  current: WorkflowDefinitionVersion | null;
  versions: WorkflowDefinitionVersion[];
}

export type ManualDispatchInput =
  | { kind: "ticket"; ticketKey: string }
  | { kind: "pull_request"; url: string };

export type ManualDispatchBlockerCode =
  | "active_run"
  | "at_capacity"
  | "approval_pending"
  | "deployment_changed"
  | "invalid_input"
  | "not_eligible"
  | "provider_unavailable";

export interface ManualDispatchPreflightStep {
  title: string;
  description: string;
}

export interface ManualDispatchPreflightResponse {
  definitionId: number;
  definitionName: string;
  deployedVersion: number;
  triggerNodeId: string;
  triggerType: WorkflowBlockType;
  input: ManualDispatchInput;
  subject: {
    kind: "ticket" | "pull_request";
    key: string;
    title: string;
    currentStatus?: string;
    url?: string;
  };
  steps: ManualDispatchPreflightStep[];
  runnable: boolean;
  blocker?: {
    code: ManualDispatchBlockerCode;
    message: string;
  };
}

export interface ManualDispatchRequest {
  requestId: string;
  expectedDeployedVersion: number;
  input: ManualDispatchInput;
}

export type ManualDispatchResponse =
  | {
      requestId: string;
      status: "started";
      runId: string;
    }
  | {
      requestId: string;
      status: "recovering";
    };

/**
 * Result of an operator cancel-by-id (POST /api/v1/runs/:runId/cancel),
 * discriminated on `outcome`. Only the non-error outcomes carry a body:
 *   - "cancelled": a live run was found and cancelled; `subjectKey` is the
 *     released subject when known (a `schedule:` prefix means a scheduled run).
 *   - "already_terminal": the run had already ended on its own. `runStatus` is
 *     the recorded status as observed and MAY be non-terminal or null, because
 *     workflow_runs can lag the registry, so it must not be read as a fresh
 *     cancellation.
 *   - "unconfirmed": a live run was found but the cancel could not be confirmed
 *     this attempt (409); the claim is retained and the operator retries.
 * An unknown run id is a 404 error without a typed body.
 */
export type RunCancelResponse =
  | { outcome: "cancelled"; runId: string; subjectKey: string | null }
  | { outcome: "already_terminal"; runId: string; runStatus: string | null }
  | { outcome: "unconfirmed"; runId: string };

/** Legacy single-definition GET shim response; removed once the dashboard
 *  switches to the multi-definition routes. */
export interface WorkflowDefinitionResponse {
  current: WorkflowDefinitionVersion | null;
  versions: WorkflowDefinitionVersion[];
  defaultDefinition: WorkflowDefinition;
  options: WorkflowEditorOptions;
}

export interface WorkflowDefinitionSaveResponse {
  meta: WorkflowDefinitionMeta;
  draft: WorkflowDefinition;
  /**
   * Deployment validation for the exact saved snapshot. A draft is still
   * persisted when validation is unavailable, in which case this is null.
   */
  validation: WorkflowDefinitionValidationResponse | null;
  validationError: string | null;
}

export interface WorkflowDefinitionLayoutResponse {
  meta: WorkflowDefinitionMeta;
  layout: WorkflowDefinitionLayout;
}

export interface WorkflowDefinitionDeploymentResponse {
  meta: WorkflowDefinitionMeta;
  deployed: WorkflowDefinitionVersion;
}

export interface WorkflowDefinitionDeploymentValidationResponse {
  error: string;
  issues: WorkflowDefinitionValidationIssue[];
}

export interface WorkflowDefinitionMigrationDiagnostic {
  code: string;
  message: string;
  nodeId: string | null;
  path?: string;
}

export interface WorkflowDefinitionMigrationPreview {
  sourceDefinitionId: number;
  sourceVersion: number;
  targetSchemaVersion: 2;
  conversionHash: string | null;
  definition: WorkflowDefinitionV2 | null;
  conversions: WorkflowDefinitionMigrationDiagnostic[];
  warnings: WorkflowDefinitionMigrationDiagnostic[];
  blockers: WorkflowDefinitionMigrationDiagnostic[];
}

export type WorkflowDefinitionMigrationResponse =
  | (WorkflowDefinitionMigrationPreview & { mode: "preview" })
  | (WorkflowDefinitionMigrationPreview & {
      mode: "apply";
      error: string;
    })
  | (WorkflowDefinitionMigrationPreview & {
      mode: "apply";
      meta: WorkflowDefinitionMeta;
      draft: WorkflowDefinitionV2;
    });

export interface WorkflowDefinitionDuplicateMigrationBlockedResponse
  extends WorkflowDefinitionMigrationPreview {
  error: string;
}

/** Everything the editor may show about a webhook trigger endpoint. The signing
 * secret is deliberately absent: it exists in cleartext only in the response
 * that created or rotated it. */
export interface WebhookEndpointConfig {
  endpointId: string;
  url: string;
  authScheme: WebhookAuthScheme;
  /** Resolved header name, already defaulted for the scheme. */
  headerName: string;
  /** True when hmac_sha256 deliveries must carry a fresh signed timestamp. */
  requireTimestamp: boolean;
  /** Resolved timestamp header name, already defaulted. Only meaningful when
   *  requireTimestamp is true. */
  timestampHeader: string;
  /** Max seconds of clock skew a timestamped delivery may carry. */
  timestampToleranceSeconds: number;
  maskedSecret: string;
  hasPendingRotation: boolean;
  /** ISO-8601 instant the previous secret stops being accepted, null when no
   *  rotation is in flight. */
  previousExpiresAt: string | null;
  /** Today's refusals grouped by reason. Rejected requests never reach the
   *  delivery log, so without this an endpoint that rejects everything looks
   *  idle rather than broken. */
  rejectionsToday: WebhookRejectionSummaryEntry[];
}

export interface WebhookRejectionSummaryEntry {
  reason: string;
  count: number;
}

/**
 * Why the editor has an endpoint to show, or why it does not yet. Each state has
 * its own operator action, so they are distinct values rather than one absent
 * endpoint: deploy the definition, set the encryption key, or revive a revoked
 * endpoint.
 */
export type WebhookEndpointState =
  | "active"
  | "inactive"
  | "revoked"
  | "await_deploy"
  | "unconfigured";

export interface WebhookEndpointConfigResponse {
  /** "active": this definition is the enabled webhook owner and receives
   *  deliveries. "inactive": the endpoint exists but a different definition is
   *  the enabled owner, so deliveries here are refused. "revoked": taken out of
   *  service. "await_deploy": node authored but not deployed, no row yet.
   *  "unconfigured": the feature has no encryption key. */
  state: WebhookEndpointState;
  /** Null exactly when no endpoint row exists yet ("await_deploy" and
   *  "unconfigured"); present for "active", "inactive", and "revoked". */
  endpoint: WebhookEndpointConfig | null;
}

export interface WebhookRotateResponse {
  endpointId: string;
  /** Cleartext, returned exactly once. */
  secret: string;
  /** ISO-8601 instant the replaced secret stops being accepted. */
  previousExpiresAt: string;
}

/** Set the signing secret to a value the sender itself generated (for example a
 *  Sentry Internal Integration Client Secret), instead of one this endpoint
 *  minted. Replaces the current secret immediately, with no dual-accept window. */
export interface WebhookSetSecretRequest {
  secret: string;
}

/** The refreshed, masked endpoint config after an import. The imported value is
 *  never echoed back, only the mask and the endpoint's public configuration. */
export type WebhookSetSecretResponse = WebhookEndpointConfig;

/** Re-read of the stored secret for an operator who missed the one-time
 *  display. Role-gated and audit-logged by the route that serves it. */
export interface WebhookRevealResponse {
  endpointId: string;
  secret: string;
}

export interface WebhookRevokeResponse {
  endpointId: string;
  /** ISO-8601 instant the endpoint stopped accepting deliveries. */
  revokedAt: string;
}

/** Reviving a revoked endpoint replaces its secret, so the new one is returned
 *  here exactly once and every older secret is dead immediately. */
export interface WebhookEndpointRevivalResponse {
  endpointId: string;
  /** Cleartext, returned exactly once. */
  secret: string;
}

/** "pending" is an accepted delivery that has not been dispatched yet (it is
 *  waiting for its subject or for capacity) and "test" is a dashboard probe that
 *  deliberately started no run. Both exist so the log never has to describe a
 *  waiting or simulated delivery as something it is not. */
export type WebhookDeliveryOutcome =
  | "started"
  | "pending"
  | "coalesced"
  | "rejected"
  | "error"
  | "test";

export interface WebhookDeliveryLogEntry {
  deliveryId: string;
  receivedAt: string;
  outcome: WebhookDeliveryOutcome;
  reason: string | null;
  runId: string | null;
  /** Which secret authenticated this delivery, so an operator can watch a
   *  rotation window actually finish. null when it was never authenticated. */
  verifiedWith: "current" | "previous" | null;
}

export interface WebhookDeliveriesResponse {
  deliveries: WebhookDeliveryLogEntry[];
}

export interface WebhookTestDeliveryRequest {
  payload: JsonValue;
}

/** What the configured mappings resolved a payload to. Mirrors the
 *  trigger_webhook block's outputs, which are all strings plus the untouched
 *  body. */
export interface WebhookMappedEntry {
  subject: string;
  description: string;
  requester: string;
  priority: string;
  payload: JsonValue;
}

export interface WebhookTestDeliveryResponse {
  outcome: WebhookDeliveryOutcome;
  reason: string | null;
  runId: string | null;
  /** Identity of the log row this probe wrote, so the operator can find it in
   *  the delivery log. Always prefixed "test:", never a real delivery id. */
  deliveryId: string;
  entry: WebhookMappedEntry;
  /** What the configured subjectPath resolved to, or null when the endpoint has
   *  none: exactly what a real delivery would use to queue per subject. */
  subjectId: string | null;
}

/** 0 is Sunday, matching the cron day-of-week field, exactly like
 *  apps/worker/src/schedule-trigger/occurrence.ts Weekday. */
export type ScheduleWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Mirrors schedule-store.ts's ScheduleOverlapPolicy: what happens when an
 *  occurrence is due while the previous one from the same schedule is still
 *  going. */
export type ScheduleOverlapPolicy = "skip" | "queue" | "allow";

/** Preset shapes the schedule editor's builder may submit, mirroring
 *  occurrence.ts's SchedulePreset field for field. The worker compiles this to a
 *  cron expression through compileSchedulePreset and validates it at the same
 *  time, so this type only names the wire shape, it proves nothing about a step
 *  being allowed. */
export type SchedulePreset =
  | { kind: "every-n-minutes"; minutes: number }
  | { kind: "every-n-hours"; hours: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekdays: ScheduleWeekday[]; hour: number; minute: number };

/** Why a cron expression, timezone or preset was rejected. Mirrors occurrence.ts's
 *  ScheduleProblem: the worker is the only cron evaluator in the system, this type
 *  only names the shape of its answer over the wire. */
export type ScheduleProblemReason =
  | "invalid-expression"
  | "invalid-timezone"
  | "below-minimum-period"
  | "never-occurs";

export interface ScheduleProblem {
  reason: ScheduleProblemReason;
  message: string;
  /** Only on "below-minimum-period": the shortest gap actually measured. */
  minGapMs?: number;
}

/** What to preview: the raw expression the user typed, or a preset for the
 *  worker to compile into one. Either way the worker is the only place a cron
 *  expression is ever evaluated. */
export type SchedulePreviewRequest =
  | { source: "cron"; cron: string; timezone: string }
  | { source: "preset"; preset: SchedulePreset; timezone: string };

export type SchedulePreviewResponse =
  | {
      ok: true;
      /** The expression that was actually evaluated: the raw input for a "cron"
       *  request, or compileSchedulePreset's output for a "preset" one. The
       *  editor stores this back into the node's own cron param. */
      cron: string;
      timezone: string;
      /** Next occurrences, ascending, ISO-8601 UTC instants. */
      runs: string[];
      /** A catch-up grace suggestion from suggestedGraceMinutes, or null when
       *  the schedule has too few occurrences to size a window. A suggestion
       *  only, for the editor to prefill: the runtime never calls the function
       *  that produces it, so a stored value never depends on it after the
       *  fact. */
      suggestedGraceMinutes: number | null;
    }
  | { ok: false; problem: ScheduleProblem };

/**
 * Whether the next-run preview can be trusted, distinct from whether an
 * occurrence happens to be due. The platform cron that evaluates schedules only
 * runs on production deployments, so a schedule can be fully deployed and
 * correctly configured and still never be evaluated in another environment:
 * that state must never look like "nothing due yet".
 *
 * "revoked" is its own state, not a variant of "not_evaluated": a revoked
 * schedule's node is simply absent from the deployed head (the definition was
 * redeployed without it, or disabled, or archived), which is not a failure and
 * must not read as one. It is also not terminal, unlike a webhook endpoint
 * revocation: restoring the node and deploying clears revoked_at automatically
 * (schedule-store.ts's resyncSchedule), so the only fix the editor offers is a
 * Refresh after that deploy, never a button.
 */
export type ScheduleEvaluationState =
  | "draft"
  | "evaluating"
  | "not_evaluated"
  | "paused"
  | "revoked";

export interface ScheduleStatus {
  scheduleId: string;
  /** The cron expression and timezone this row was last deployed with (the
   *  four authored columns resyncSchedule writes on deploy). Distinct from
   *  whatever the editor's own draft currently holds: the editor's "Next
   *  occurrences" preview is computed from the draft, which can differ from
   *  what actually runs until the next deploy, and the editor needs both
   *  values to say so. */
  cron: string;
  timezone: string;
  pausedAt: string | null;
  revokedAt: string | null;
  /** Null when the scheduler has never evaluated this schedule in this
   *  environment. The only column that separates "nothing due yet" from
   *  "nothing is even looking". Deliberately NOT the evaluation watermark: that
   *  column is an internal engine cursor (it can point at an instant that never
   *  corresponded to a real occurrence, right after a mint or a resume) and must
   *  never be shown to a user as if it meant something. */
  lastEvaluatedAt: string | null;
  /** The last occurrence that actually started a run, and that run's id. Both
   *  null until the first run ever starts. This is what the editor renders as
   *  "last run": it is the only pair that outlives the occurrence ledger's
   *  retention window, so a schedule that last ran months ago can still say so
   *  after its ledger rows have been swept. */
  lastStartedOccurrenceAt: string | null;
  lastStartedRunId: string | null;
  /** Server clock at response time, so the editor's staleness read and any
   *  relative copy do not depend on the browser's clock. */
  serverNow: string;
}

/** Every decision the occurrence ledger can record, mirroring
 *  occurrence-store.ts's ScheduleOccurrenceOutcome exactly. There is
 *  deliberately no "skipped_capacity": being at capacity is not a decision
 *  about an occurrence, it is a reason a still-pending one has not run yet, so
 *  it is an annotation (see skipReason and attemptCount on a pending entry)
 *  rather than an outcome. */
export type ScheduleOccurrenceOutcome =
  | "started"
  | "skipped_overlap"
  | "skipped_stale"
  | "superseded"
  | "cancelled"
  | "run_cancelled"
  | "expired"
  | "error";

/** One row of the occurrence ledger, as the editor may show it. `outcome` is
 *  null while `pending` is true: the occurrence was admitted but not yet
 *  decided, and may still carry an annotation (skipReason "at_capacity", or an
 *  "error" outcome alongside pending: true for a failed attempt that will
 *  retry) rather than a settlement. */
export interface ScheduleOccurrenceEntry {
  occurrenceAt: string;
  pending: boolean;
  outcome: ScheduleOccurrenceOutcome | null;
  skipReason: string | null;
  /** Which run held the subject for an overlap skip, so an operator can see
   *  which run is blocking the schedule. */
  blockingRunId: string | null;
  runId: string | null;
  droppedCount: number;
  /** True when droppedCount is a floor, not an exact number, because the
   *  evaluator stopped counting at its backlog cap. The editor must render
   *  "at least N", never a bare N, or it invents precision the evaluator
   *  deliberately refused to invent. */
  droppedCountCapped: boolean;
  /** How many dispatch attempts this occurrence has absorbed. Worth showing
   *  only once it is past one: "0 or 1" and "twelve failed attempts" must not
   *  render identically, since the count is the only pointer to the logs. */
  attemptCount: number;
}

export interface ScheduleConfigResponse {
  state: ScheduleEvaluationState;
  /** Null exactly when state is "draft": the node is authored but has never
   *  been deployed, so no schedule row exists yet. */
  schedule: ScheduleStatus | null;
  /** This schedule's recent ledger, newest first, from
   *  listOccurrencesForSchedule. An empty array is a true "no occurrences yet". */
  occurrences: ScheduleOccurrenceEntry[];
}

export interface SchedulePauseResponse {
  scheduleId: string;
  pausedAt: string;
}

/** No watermark field on purpose: the evaluation watermark is an internal
 *  engine cursor the contract forbids showing to a user (see ScheduleStatus's
 *  own doc comment), and nothing in the editor reads it. */
export interface ScheduleResumeResponse {
  scheduleId: string;
}

export interface WorkflowAvailableValueSource {
  kind: "entry" | "step" | "run";
  nodeId: string | null;
  blockType: WorkflowBlockType | null;
}

export interface WorkflowAvailableValueGuarantee {
  kind: "active_entry" | "unconditional_activation" | "join";
  triggerNodeIds: string[];
  viaEdgeIds: string[];
}

/** One value that is guaranteed to exist when a particular v2 block runs. */
export interface WorkflowAvailableValue {
  reference: WorkflowDataReferenceV2;
  label: string;
  description: string | null;
  schema: JsonSchema202012;
  source: WorkflowAvailableValueSource;
  guarantee: WorkflowAvailableValueGuarantee;
  /** Fixed or author-defined input names that can accept this value. */
  compatibleInputNames: string[];
}

export type WorkflowAvailableValuesByNode = Record<string, WorkflowAvailableValue[]>;

export type NodeDataContract = WorkflowBlockContract;

export type WorkflowDataCatalogPresence =
  | "required"
  | "optional"
  | "nullable"
  | "optional_nullable";

export type WorkflowDataCatalogAvailability =
  | { state: "available"; guarantee: string }
  | { state: "unavailable"; reason: string };

export interface WorkflowDataCatalogEntry {
  reference: WorkflowDataReferenceV2;
  label: string;
  description: string;
  schema: JsonSchema202012;
  source: {
    kind: "trigger" | "step" | "run";
    nodeId?: string;
  };
  presence: WorkflowDataCatalogPresence;
  availability: WorkflowDataCatalogAvailability;
  compatibleInputNames: string[];
  /** Array input names whose item schema can accept this value. */
  compatibleListInputNames?: string[];
  example?: JsonValue;
}

export interface WorkflowDefinitionCatalogResponse {
  nodeContracts: Record<string, NodeDataContract>;
  catalogByNode: Record<string, WorkflowDataCatalogEntry[]>;
}

export interface WorkflowDefinitionValidationResponse {
  valid: boolean;
  issues: WorkflowDefinitionValidationIssue[];
  /** Parameter-resolved contracts for the exact candidate graph. */
  nodeContracts: Record<string, WorkflowBlockContract>;
  /** Worker-owned v2 data-flow catalog, keyed by consuming block id. */
  availableValuesByNode: WorkflowAvailableValuesByNode;
}

export interface WorkflowDefinitionValidationIssue {
  code: string;
  severity: "error";
  nodeId: string | null;
  /** JSON Pointer identifying the offending value when one is available. */
  path?: string;
  message: string;
}

export interface JsonSchemaAuthoringIssue {
  code:
    | "invalid_json"
    | "invalid_schema"
    | "unsupported_keyword"
    | "unsupported_type";
  /** RFC 6901 pointer into the authored schema. Empty means the root. */
  path: string;
  message: string;
}

/** Result returned by the worker-owned JSON Schema 2020-12 authoring service. */
export type JsonSchemaAuthoringInspectionResponse =
  | {
      deployable: true;
      dialect: "https://json-schema.org/draft/2020-12/schema";
      schema: JsonSchema202012;
      valueSchema: WorkflowValueSchema;
      issues: [];
    }
  | {
      deployable: false;
      dialect: "https://json-schema.org/draft/2020-12/schema";
      schema: JsonSchema202012 | null;
      valueSchema: null;
      issues: JsonSchemaAuthoringIssue[];
    };

export interface RunBlockStatusesResponse {
  generatedAt: string;
  run: RunBlockStatusSnapshot | null;
}

export interface ApprovalsResponse {
  generatedAt: string;
  approvals: ApprovalRequest[];
}

export interface ApprovalDecisionResponse {
  approval: ApprovalRequest;
  /** Run started on approval; null for a rejection. */
  runId: string | null;
}

export interface ClarificationAnswerResponse {
  clarification: ClarificationRequest;
  /** The same asking run resumed by the answer. */
  runId: string | null;
}

// --- Prompt library (dashboard-authored reusable prompts) ---

export interface PromptLibraryEntryMeta {
  id: number;
  /** Immutable, human-readable reference key ({{prompt:<slug>}}). Assigned at
   *  create time from the name; renames do not change it. */
  slug: string;
  name: string;
  description: string | null;
  tags: string[];
  /** Head version number; always >= 1 (create seeds version 1). */
  currentVersion: number;
  /** Non-null when the prompt is archived (soft delete). */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByLabel: string;
}

export interface PromptLibraryVersion {
  promptId: number;
  version: number;
  body: string;
  slots: PromptSlotDefinition[];
  createdAt: string;
  createdById: string;
  createdByLabel: string;
  restoredFromVersion: number | null;
}

/** List row = meta + head body, so the editor's insert picker and the drift
 *  check need no per-prompt fetch. */
export interface PromptLibraryListRowDto extends PromptLibraryEntryMeta {
  body: string;
  slots: PromptSlotDefinition[];
}

export interface PromptLibraryListResponse {
  prompts: PromptLibraryListRowDto[];
  /** Distinct tags computed across the returned (possibly filtered) prompts,
   *  not the whole library; sorted, for the filter chips. */
  tags: string[];
}

export interface PromptLibraryDetailResponse {
  meta: PromptLibraryEntryMeta;
  current: PromptLibraryVersion;
  /** Newest first, capped at 50. */
  versions: PromptLibraryVersion[];
}

export interface PromptLibrarySaveResponse {
  meta: PromptLibraryEntryMeta;
  version: PromptLibraryVersion;
  /** false when the submitted body and slots equaled the head and nothing was appended. */
  changed: boolean;
}

export interface PromptLibraryVersionResponse {
  version: PromptLibraryVersion;
}

/** One workflow-definition block param that carries text copied from a
 *  library prompt, with its sync state against the library. */
export interface PromptLibraryUsageRow {
  definitionId: number;
  definitionName: string;
  nodeId: string;
  nodeName: string | null;
  blockType: WorkflowBlockType;
  paramKey: string;
  /** Library version recorded at insert time. */
  version: number;
  state: "current" | "behind" | "modified";
}

/** Another library prompt whose head body references this prompt via a
 *  {{prompt:...}} token (prompt-in-prompt composition). */
export interface PromptLibraryPromptUsageRow {
  promptId: number;
  slug: string;
  name: string;
  /** Version the reference resolves to today (latest maps to the current head). */
  version: number;
  state: "current" | "behind";
}

export interface PromptLibraryUsageResponse {
  rows: PromptLibraryUsageRow[];
  prompts: PromptLibraryPromptUsageRow[];
}

/** One stored agent memory document, without its body. */
export interface MemoryDocumentSummaryDto {
  /** Canonical identity of the run subject the document belongs to. */
  subjectKey: string;
  docPath: string;
  ticketKey: string | null;
  bytes: number;
  sourceRunId: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryDocumentsResponse {
  /** Newest first, capped by the store's list limit. */
  documents: MemoryDocumentSummaryDto[];
}

/** A single document with its body; `subjectKey` / `docPath` echo the request. */
export interface MemoryDocumentDto {
  subjectKey: string;
  docPath: string;
  bytes: number;
  sourceRunId: string;
  updatedAt: string;
  content: string;
}

export interface MemoryDocumentResponse {
  document: MemoryDocumentDto;
}

/* ── System health (dashboard Health screen) ─────────────────────────────── */

/**
 * `live` / `down` / `degraded` describe entries with a real probe result;
 * `configured` / `not-configured` / `misconfigured` describe presence-only
 * entries; `mock` means the system deliberately runs a no-op adapter (Slack
 * without a token). Every probed check resolves to a probe result: there is no
 * "unverified" state, a check that cannot be verified is not listed.
 */
export type SystemHealthMode =
  | "live"
  | "down"
  | "degraded"
  | "configured"
  | "not-configured"
  | "misconfigured"
  | "mock";

export type SystemHealthGroup = "core" | "auth-email" | "platform";

export interface SystemHealthPing {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export type SystemHealthEvidenceSource =
  | "live-probe"
  | "provider-config"
  | "provider-delivery"
  | "local-observation"
  | "configuration";

export interface SystemHealthCheck {
  id: string;
  label: string;
  description: string;
  /** A failed required check determines the parent integration status. */
  critical: boolean;
  mode: SystemHealthMode;
  /** Variable NAMES only — values never leave the worker. */
  envVars: string[];
  evidenceSource: SystemHealthEvidenceSource;
  checkedAt?: string;
  observedAt?: string;
  latencyMs?: number;
  message?: string;
  coverage?: { checked: number; total: number };
}

export interface SystemHealthIntegration {
  id: string;
  label: string;
  group: SystemHealthGroup;
  /** Variable NAMES only — values never leave the worker. */
  envVars: string[];
  /** A failure blocks the workflow itself (issue tracker, VCS, agent, DB). */
  critical: boolean;
  mode: SystemHealthMode;
  /** Why a partially-set integration counts as misconfigured. */
  configError?: string;
  ping: SystemHealthPing | null;
  checks: SystemHealthCheck[];
}

export interface SystemHealthResponse {
  generatedAt: string;
  summary: {
    total: number;
    live: number;
    down: number;
    notConfigured: number;
    criticalDown: number;
    checksTotal: number;
    checksLive: number;
    checksDown: number;
    checksDegraded: number;
  };
  integrations: SystemHealthIntegration[];
}
