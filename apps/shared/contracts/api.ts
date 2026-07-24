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
    "ticket" | "ticketUrl" | "ticketTitle" | "prNumber" | "prUrl"
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
