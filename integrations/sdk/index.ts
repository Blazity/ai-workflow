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
 * `VCSAdapter`, `MessagingAdapter`. The ports of `memory`, `agent_tracing` and
 * `agent_tools` are reserved (see `INTEGRATION_CAPABILITIES`).
 *
 * `checkIntegrationConformance` is what CI runs over every integration.
 * ADR-010 records why the contract has this shape and every later change.
 *
 * This entry reaches no Node module; a test bundles it for the browser.
 */
export { z } from "zod";

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
  type LatestCheckRun,
  type PostRunFailureNoteInput,
  type PRComment,
  type PullRequest,
  type PullRequestHead,
  type ReviewThread,
  type ReviewThreadFeed,
  type ReviewThreadNote,
  type ReviewThreadSource,
  type ReviewThreadTarget,
  type SettleReviewThreadAction,
  type SettleReviewThreadInput,
  type SettleReviewThreadResult,
  type VCSAdapter,
} from "./vcs";

export type { MessagingAdapter, TicketEvent } from "./messaging";
