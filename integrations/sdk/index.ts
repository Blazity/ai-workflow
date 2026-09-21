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
 * - `dashboard`: the React side of its pages, designed in S7.
 *
 * What it receives is an `IntegrationContext` (see `context.ts`): its resolved
 * connection, an HTTP client, a logger, and while a block runs, the run's
 * identity, the capabilities the block declared and a core-owned `llm`.
 * Nothing else: no database, no process environment, no worker import, and no
 * step directive anywhere in integration code.
 *
 * What it implements for a capability is a port: `IssueTrackerAdapter`,
 * `VCSAdapter`, `MessagingAdapter`, `AgentTracingAdapter`. The ports of
 * `memory` and `agent_tools` are reserved (see `INTEGRATION_CAPABILITIES`).
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
  type IntegrationCapabilityAccess,
  type IntegrationCapabilityId,
  type IntegrationCapabilityPorts,
  type ProvidedCapabilityId,
  type ReservedCapabilityId,
  type VcsRepositoryRef,
  type VcsRepositoryTarget,
} from "./capabilities";

export {
  defineIntegration,
  defineIntegrationBlock,
  type ConnectionField,
  type IntegrationBlockManifest,
  type IntegrationBlockOutput,
  type IntegrationBlockRequirements,
  type IntegrationConnection,
  type IntegrationHealthCheck,
  type IntegrationManifest,
  type IntegrationPage,
  type IntegrationRepositoryShape,
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

export { FatalError } from "./errors";

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
  type IssueTrackerMoveTarget,
  type IssueTrackerTransitionTarget,
  type TicketAttachment,
  type TicketComment,
  type TicketContent,
  type TicketSummary,
} from "./issue-tracker";

export {
  REVIEW_LEDGER_MAX_CONTEXT_THREADS,
  REVIEW_LEDGER_MAX_WORK_ITEMS,
  type CheckRunResult,
  type CheckRunConclusion,
  type GateStatusRef,
  type GateStatusUpdate,
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
  type VcsIntegrationAdapter,
  type VcsOpaqueHandle,
  type VcsRepositoryMetadata,
  type VcsSandboxCredentials,
} from "./vcs";

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
  TriggerEvent,
} from "./webhook";
