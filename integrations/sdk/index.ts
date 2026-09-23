/**
 * @integrations/sdk: what an integration is, and what it receives.
 *
 * An integration is one package, `integrations/<id>`, with up to three entry
 * points:
 *
 * - `manifest`: `defineIntegration({...})`. Plain data core reads without
 *   running any integration code: identity, connection fields (with their
 *   secret flags and environment variables), the capabilities it serves, its
 *   blocks, its pages and its health checks. No Node modules, because the
 *   dashboard and the Workflow DevKit's flow bundle read it too.
 * - `worker`: `defineIntegrationRuntime(manifest, {...})`. The code: a
 *   connection test, one adapter per declared capability, one executor per
 *   declared block, one probe per declared health check. Server only.
 * - `dashboard`: one React component per declared page, built from
 *   `@integrations/host-ui`, whose `defineIntegrationDashboard` types it.
 *
 * What core hands it is an `IntegrationContext` (see `context.ts`): its
 * resolved connection, an HTTP client, a logger, a deadline, and while a block
 * runs, the run's identity, the capabilities the block declared and a
 * core-owned `llm`. Nothing else is handed: no database, no process
 * environment, no worker import. What integration code can reach is wider,
 * because it runs in our processes and nothing is sandboxed; the rules around
 * it are against coupling, and docs/architecture/integrations.md says what
 * each one protects. No step directive belongs anywhere in integration code.
 *
 * What it implements for a capability is a port: `IssueTrackerAdapter`,
 * `VCSAdapter`, `MessagingAdapter`, `MemoryAdapter`, `AgentTracingAdapter`.
 * The port of `agent_tools` is reserved (see `INTEGRATION_CAPABILITIES`).
 *
 * `checkIntegrationConformance` is what CI runs over every integration.
 * ADR-010 records why the contract has this shape and every later change.
 *
 * This entry reaches no Node module; a test bundles it for the browser.
 */
export { z } from "zod";

export {
  AGENT_TRACING_DIR_TOKEN,
  AGENT_TRACING_EVENTS,
  type AgentTracingAdapter,
  type AgentTracingEvent,
  type AgentTracingFile,
  type AgentTracingHook,
  type AgentTracingInvocation,
  type AgentTracingPackage,
  type AgentTracingSetup,
} from "./agent-tracing";

export type { IntegrationRunStart, IntegrationRunState } from "./run-state";

export {
  INTEGRATION_CAPABILITIES,
  capabilityLabel,
  NESTED_ADAPTER_MEMBERS,
  type NestedAdapterRole,
  type IntegrationCapabilityAccess,
  type IntegrationCapabilityId,
  type IntegrationCapabilityPorts,
  type ProvidedCapabilityId,
  type ReservedCapabilityId,
  type VcsRepositoryRef,
  type VcsRepositoryTarget,
} from "./capabilities";

export {
  isPullRequestRefusal,
  isPullRequestUnreadableError,
  PullRequestUnreadableError,
} from "./pull-request-unreadable";

export {
  connectionValueProblem,
  defineIntegration,
  defineIntegrationBlock,
  type ConnectionValueProblem,
  type ConnectionField,
  type IntegrationBlockManifest,
  type IntegrationBlockOutput,
  type IntegrationBlockRequirements,
  type IntegrationConnection,
  type IntegrationHealthCheck,
  type IntegrationManifest,
  type IntegrationChangeRequestShape,
  type IntegrationPage,
  type IntegrationRepositoryShape,
  type IntegrationWebhookManifest,
  type VcsReviewState,
} from "./manifest";

export {
  INTEGRATION_HTTP_DEFAULTS,
  type ConnectionValues,
  type IntegrationBlockContext,
  type IntegrationContext,
  type IntegrationHttp,
  type IntegrationLlm,
  type IntegrationLlmRequest,
  type IntegrationLogFields,
  type IntegrationLogger,
  type IntegrationRequestInit,
  type IntegrationRunIdentity,
} from "./context";

export {
  defineIntegrationRuntime,
  type ConnectionTestResult,
  type ErasedIntegrationCall,
  type ErasedIntegrationRuntime,
  type IntegrationBlockExecutor,
  type IntegrationBlockInvocation,
  type IntegrationBlockOutcome,
  type IntegrationBlockOutputValue,
  type IntegrationCapabilityFactories,
  type IntegrationHealthResult,
  type IntegrationRuntime,
  type IntegrationRuntimeDefinition,
} from "./runtime";

export { ConnectionValueError, FatalError } from "./errors";

export {
  PROVIDER_VERDICT_HEADERS,
  providerAnswer,
  readProviderFailure,
  refusedOrThrow,
  type ProviderAnswer,
  type ProviderFailure,
} from "./provider-failure";

export {
  boundRepositoryProfileBundle,
  isRepositoryProfileLockfile,
  isRepositoryProfileManifest,
  pickRepositoryProfileReadme,
  RepositoryMissingAtProviderError,
  REPOSITORY_PROFILE_DEADLINE_MS,
  REPOSITORY_PROFILE_MAX_CI_FILES,
  REPOSITORY_PROFILE_MAX_MANIFESTS,
  REPOSITORY_PROFILE_TRUNCATION_MARKER,
  type RepositoryProfileBundle,
  type RepositoryProfileFile,
  type RepositoryProfileSource,
  type VcsProviderId,
} from "./repository-profile";

/**
 * What core answers a run control command with, and the pull requests a
 * `pr_ready` event carries, re-exported so an integration reaches them the way
 * it reaches everything else: through this package. An integration may not
 * depend on `@shared/contracts` directly (the boundaries gate and the
 * conformance dependency check both say so), and a messaging provider has to
 * render both.
 */
export {
  pullRequestRef,
  pullRequestRepoLabels,
  type RunControlAnswer,
  type RunControlCancelOutcome,
  type RunControlCommand,
  type RunControlEntry,
  type RunControlFailedRun,
  type RunControlOutcome,
  type RunControlResetOutcome,
  type RunControlResetTarget,
  type RunControlRun,
  type RunPullRequest,
  type JsonValue,
} from "@shared/contracts";

export {
  CORE_HEALTH_SECTION_IDS,
  RESERVED_ENVIRONMENT_VARIABLES,
  RESERVED_HEALTH_CHECK_ID,
  RESERVED_INTEGRATION_IDS,
  checkIntegrationConformance,
  type ConformanceCode,
  type ConformanceIssue,
} from "./conformance";

export {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
  type IssueTrackerQueryRule,
  type IssueTrackerMoveTarget,
  type IssueTrackerTransitionTarget,
  type TicketAttachment,
  type TicketComment,
  type TicketContent,
  type TicketSummary,
} from "./issue-tracker";

export {
  GATE_CHECK_NAME_PREFIX,
  LEGACY_GATE_CHECK_NAME_PREFIX,
  isManagedGateCheckName,
  isReviewLedgerWorkItem,
  normalizeVcsLogin,
  selectReviewLedgerWorkItems,
  vcsLoginsMatch,
  REVIEW_LEDGER_MAX_CONTEXT_THREADS,
  REVIEW_LEDGER_MAX_WORK_ITEMS,
  VCS_BOT_LOGIN_FIELD,
  VCS_LEGACY_BOT_LOGIN_FIELD,
  type CheckRunResult,
  type PostRunFailureNoteInput,
  type PRComment,
  type PullRequest,
  type PullRequestHead,
  type PullRequestHeadChecks,
  type PullRequestFailedCheck,
  type RepositorySkillSource,
  type RepositorySkillTreeEntry,
  type ReviewThread,
  type ReviewThreadFeed,
  type ReviewThreadNote,
  type ReviewThreadSource,
  type ReviewThreadTarget,
  type SettleReviewThreadAction,
  type SettleReviewThreadInput,
  type SettleReviewThreadResult,
  type VCSAdapter,
  type VcsHandleIdentity,
  type VcsOpaqueHandle,
  type VcsRepositoryMetadata,
  type VcsSandboxCredentials,
} from "./vcs";

export {
  hasGateStatusCapability,
  hasManualDispatchPrCapability,
  hasPRFilesCapability,
  hasPRReviewCapability,
  hasRichGateStatusCapability,
  reviewFallbackBullet,
  type CheckRunAnnotation,
  type CheckRunConclusion,
  type GateStatusCapableVCS,
  type GateStatusRef,
  type GateStatusUpdate,
  type ManualDispatchPrCapableVCS,
  type ManualDispatchPullRequestSnapshot,
  type PRFile,
  type PRFilesCapableVCS,
  type PRReviewCapableVCS,
  type PRReviewInlineComment,
  type PRReviewPublication,
  type PRReviewPublicationResult,
  type RichGateStatusCapableVCS,
  type RichGateStatusUpdate,
  type VcsIntegrationAdapter,
} from "./vcs-extensions";

export {
  AI_WORKFLOW_COMMENT_MARKER,
  AI_WORKFLOW_MARKER_PATTERN,
  hasAiWorkflowCommentMarker,
  hasReviewLedgerFailureMarker,
  hasUnquotedAiWorkflowCommentMarker,
  isOurOwnVcsComment,
  isReopenedLedgerThread,
  isReviewLedgerNote,
  legacyReviewCommentMarker,
  markReviewLedgerReplyResolved,
  markReviewLedgerReplyStale,
  readAnyReviewLedgerMarker,
  readReviewFindingDigest,
  readReviewLedgerMarker,
  reviewFindingMarker,
  reviewHeadMarker,
  reviewLedgerFailureMarker,
  reviewLedgerMarker,
  reviewSummaryMarker,
} from "./review-markers";

export type {
  MemoryAdapter,
  MemoryEntry,
  MemoryFailure,
  MemoryObservation,
  MemoryObserveRequest,
  MemoryRecall,
  MemoryRecallRequest,
  MemoryScope,
  MemoryScopeKind,
  MemoryStoreAdapter,
  MemoryStoreListing,
  MemoryStoredDocument,
  MemoryStoredDocumentRef,
  MemoryStoredSummary,
  MemorySubject,
  MemoryWrite,
} from "./memory";
export { MEMORY_NOTEBOOK_MAX_BYTES, MEMORY_PROMPT_BUDGET_BYTES } from "./memory";

export type {
  MessageRetrievalFailure,
  MessageSearchMatch,
  MessageSearchOutcome,
  MessageSearchQuery,
  MessageSearchSkip,
  MessagingAdapter,
  MessagingConversation,
  MessagingDelivery,
  MessagingSender,
  MessagingTicket,
  TicketEvent,
} from "./messaging";

export type {
  IntegrationWebhook,
  IntegrationWebhookReception,
  IntegrationWebhookRequest,
  IntegrationWebhookResponse,
  PrTriggerPayload,
  TrackerTicketEvent,
  TriggerEvent,
} from "./webhook";
