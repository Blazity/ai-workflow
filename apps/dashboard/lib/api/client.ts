"use client";

import type {
  ApprovalDecisionResponse,
  ClarificationAnswerResponse,
  HarnessCapabilitiesResponse,
  HarnessLocalSkillDiscoveryResponse,
  HarnessLocalSkillImportRequest,
  HarnessProfileDetailResponse,
  HarnessProfileDraftManifest,
  HarnessProfileMutationResponse,
  HarnessProfilePublishResponse,
  HarnessProfilesResponse,
  HarnessSkillDiscoverRequest,
  HarnessSkillDiscoveryResponse,
  HarnessSkillImportRequest,
  HarnessSkillImportResponse,
  HarnessSkillRefreshResponse,
  IntegrationConnectionSaveRequest,
  IntegrationImpactPreviewRequest,
  IntegrationImpactPreviewResponse,
  IntegrationMutationResponse,
  IntegrationSource,
  IntegrationVersionConflict,
  IntegrationsListResponse,
  JsonSchemaAuthoringInspectionResponse,
  ManualDispatchInput,
  ManualDispatchPreflightResponse,
  ManualDispatchRequest,
  ManualDispatchResponse,
  PrePrChecksResponse,
  PromptLibraryDetailResponse,
  PromptLibraryListResponse,
  PromptLibrarySaveResponse,
  PromptLibraryUsageResponse,
  PromptLibraryVersionResponse,
  PromptSlotDefinition,
  RepositoriesResponse,
  RepositoryCatalogActivateBlocked,
  RepositoryCatalogActivateConflict,
  RepositoryCatalogActivateResponse,
  RepositoryCatalogEntryResponse,
  RepositoryCatalogImportPreviewResponse,
  RepositoryCatalogImportResponse,
  RepositoryCatalogListResponse,
  RepositoryCatalogMutationResponse,
  RepositoryCatalogProfileConflict,
  RepositoryCatalogSuggestRateLimited,
  RepositoryCatalogSuggestError,
  RepositoryCatalogSuggestResponse,
  RepositoryCatalogSuggestionsResponse,
  RepositoryCatalogUpsertRequest,
  RepositoryCatalogVersionsResponse,
  RunCancelResponse,
  RunStatus,
  ScheduleConfigResponse,
  SchedulePauseResponse,
  SchedulePreviewRequest,
  SchedulePreviewResponse,
  ScheduleResumeResponse,
  SettingsPatchRequest,
  SettingsPatchResponse,
  SettingsVersionsResponse,
  SystemHealthResponse,
  WebhookDeliveriesResponse,
  WebhookEndpointConfigResponse,
  WebhookEndpointRevivalResponse,
  WebhookRevealResponse,
  WebhookRejectionSummaryEntry,
  WebhookRevokeResponse,
  WebhookRotateResponse,
  WebhookSetSecretRequest,
  WebhookSetSecretResponse,
  WebhookTestDeliveryRequest,
  WebhookTestDeliveryResponse,
  WorkflowDefinition,
  WorkflowDefinitionCatalogResponse,
  WorkflowDefinitionDeploymentResponse,
  WorkflowDefinitionDeploymentValidationResponse,
  WorkflowDefinitionDetailResponse,
  WorkflowDefinitionLayout,
  WorkflowDefinitionLayoutResponse,
  WorkflowDefinitionMeta,
  WorkflowDefinitionSaveResponse,
  WorkflowDefinitionValidationIssue,
  WorkflowDefinitionValidationResponse,
  WorkflowReplayAttemptDetail,
  WorkflowRunReplayResponse,
} from "@shared/contracts";
import { readErrorMessage } from "./error-message";

interface ApiSuccess<T> {
  ok: true;
  status: number;
  data: T;
}

interface ApiFailure<E> {
  ok: false;
  status: number;
  error: E;
  errorMessage: string;
}

export type ApiResult<T, E = unknown> = ApiSuccess<T> | ApiFailure<E>;

export interface BrowserRequestOptions {
  cache?: RequestCache;
  signal?: AbortSignal;
}

export interface AuthInviteState {
  email: string;
  organizationName: string;
  role: "owner" | "admin" | "member";
  mode: "new_user" | "existing_password" | "sso_only";
}

interface AuthErrorResponse {
  error?: string;
  message?: string;
}

export interface DashboardInviteResponse {
  id: string;
  email: string;
  invitedBy: string;
  role: "member";
  status: "pending" | "accepted" | "canceled" | "expired";
  emailStatus: "pending_send" | "queued" | "sent" | "failed" | "bounced" | null;
  expiresAt: string | null;
  sentAt: string;
  actions: {
    canResend: boolean;
    canCancel: boolean;
  };
}

export interface EffectivePromptPreviewProvenance {
  kind: "profile" | "repository" | "memory" | "prompt" | "runtime";
  id: string;
  version: number | null;
  hash: string;
}

interface EffectivePromptPreviewSection {
  kind: "profile" | "repository" | "memory" | "block" | "runtime";
  title: string;
  content: string;
  hash: string;
  provenance: EffectivePromptPreviewProvenance[];
}

interface EffectivePromptPreviewUnresolvedSource {
  kind: "profile" | "repository" | "data" | "slot";
  reference: string;
  message: string;
  /** `filled_at_run`, `fails_the_run` or `not_in_preview`: what execution does
   *  with this source. Absent from a worker older than the contract, and read
   *  as a claim nobody made rather than as a harmless one. */
  atRun?: string;
}

/**
 * The fields below `issues` arrived with the worker's truthful preview and are
 * all OPTIONAL here, because the worker and the dashboard deploy separately: a
 * worker from before it says nothing about the profile switches, and a screen
 * that filled in a default would be inventing the very fact it exists to show.
 */
export interface EffectivePromptPreviewResponse {
  blockId: string;
  prompt: string;
  hash: string;
  sections: EffectivePromptPreviewSection[];
  provenance: EffectivePromptPreviewProvenance[];
  unresolvedSources: EffectivePromptPreviewUnresolvedSource[];
  issues: WorkflowDefinitionValidationIssue[];
  /** The applied profile's own switches, as execution reads them. */
  context?: { includeWorkflowData: boolean; includeRepositoryInstructions: boolean };
  /** The profile this prompt was compiled with; null where the one the block
   *  names could not be resolved, which a run refuses to start on. */
  profile?: { profileId: string; version: number; name: string; applied: string } | null;
  /** Sections only a prepared workspace composes, named rather than missing. */
  notPreviewable?: { kind: string; reason: string }[];
}

interface RunSearchHit {
  id: string;
  ticket: string;
  ticketTitle: string;
  workflowName: string;
  status: RunStatus;
  startedAtMin: number;
  runCount: number;
}

interface RunSearchResponse {
  rows?: RunSearchHit[];
}

type WebhookActionResponse =
  | WebhookRevealResponse
  | WebhookRotateResponse
  | WebhookEndpointRevivalResponse
  | WebhookRevokeResponse;

type JsonBody = Record<string, unknown> | readonly unknown[] | string | number | boolean | null;

async function parsedErrorBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function requestJson<T, E = unknown>(
  path: string,
  init?: RequestInit,
  acceptedStatus?: (status: number) => boolean,
  invalidSuccessBody?: () => T,
): Promise<ApiResult<T, E>> {
  const response = await fetch(path, init);
  const accepted = acceptedStatus?.(response.status) ?? response.ok;
  if (accepted) {
    let data: T;
    try {
      data = (await response.json()) as T;
    } catch (error) {
      if (!invalidSuccessBody) throw error;
      data = invalidSuccessBody();
    }
    return {
      ok: true,
      status: response.status,
      data,
    };
  }
  const errorMessage = await readErrorMessage(response.clone());
  return {
    ok: false,
    status: response.status,
    error: (await parsedErrorBody(response)) as E,
    errorMessage,
  };
}

async function requestVoid<E = unknown>(
  path: string,
  init?: RequestInit,
): Promise<ApiResult<void, E>> {
  const response = await fetch(path, init);
  if (response.ok) return { ok: true, status: response.status, data: undefined };
  const errorMessage = await readErrorMessage(response.clone());
  return {
    ok: false,
    status: response.status,
    error: (await parsedErrorBody(response)) as E,
    errorMessage,
  };
}

function jsonInit(
  method: "POST" | "PUT" | "PATCH",
  body: JsonBody | object,
  options?: BrowserRequestOptions,
): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...options,
  };
}

/** A path with the given query parameters, leaving out the ones not set. */
function withParams(path: string, params: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) query.set(name, String(value));
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

function briefingPath(runId: string, briefingId: string, suffix: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/briefings/${encodeURIComponent(briefingId)}/${suffix}`;
}

/** A page of a cursor-paged list: where it starts and, optionally, how many
 *  bytes it may hold. */
interface ListPageRequest {
  cursor?: string | null;
  limit?: number;
}

function definitionTriggerPath(
  definitionId: number,
  nodeId: string,
  suffix: string,
): string {
  return `/api/workflow-definitions/${definitionId}/triggers/${encodeURIComponent(nodeId)}/${suffix}`;
}

export const apiClient = {
  auth: {
    ssoStatus: (options?: BrowserRequestOptions) =>
      requestJson<{ enabled?: unknown }>("/api/auth/sso/status", options),
    login: (body: { email: string; password: string }) =>
      requestVoid<AuthErrorResponse>("/api/auth/login", jsonInit("POST", body)),
    forgotPassword: (body: { email: string }) =>
      requestVoid<AuthErrorResponse>(
        "/api/auth/forgot-password",
        jsonInit("POST", body),
      ),
    resetPassword: (body: { token: string; password: string }) =>
      requestVoid<AuthErrorResponse>(
        "/api/auth/reset-password",
        jsonInit("POST", body),
      ),
    invite: (inviteId: string) =>
      requestJson<AuthInviteState, AuthErrorResponse>(
        `/api/auth/invite/${encodeURIComponent(inviteId)}`,
        undefined,
        undefined,
        () => ({}) as AuthInviteState,
      ),
    acceptInvite: (body: {
      inviteId: string;
      name?: string;
      password: string;
    }) =>
      requestVoid<AuthErrorResponse>(
        "/api/auth/invite/accept",
        jsonInit("POST", body),
      ),
    logout: () => requestVoid("/api/auth/logout", { method: "POST" }),
  },

  approvals: {
    decide: (id: string, action: "approve" | "reject") =>
      requestJson<ApprovalDecisionResponse>(
        `/api/approvals/${encodeURIComponent(id)}/${action}`,
        { method: "POST" },
      ),
  },

  clarifications: {
    answer: (id: string, answer: string) =>
      requestJson<ClarificationAnswerResponse>(
        `/api/clarifications/${encodeURIComponent(id)}/answer`,
        jsonInit("POST", { answer }),
      ),
  },

  harnessCapabilities: {
    get: (
      provider: string,
      cliVersion: string,
      options?: BrowserRequestOptions,
    ) => {
      const query = new URLSearchParams({ provider, cliVersion });
      return requestJson<HarnessCapabilitiesResponse>(
        `/api/harness-capabilities?${query.toString()}`,
        options,
      );
    },
  },

  harnessProfiles: {
    list: (options?: BrowserRequestOptions) =>
      requestJson<HarnessProfilesResponse>("/api/harness-profiles", options),
    detail: (
      profileId: string,
      requestedVersion?: number,
      options?: BrowserRequestOptions,
    ) => {
      const query = requestedVersion === undefined ? "" : `?version=${requestedVersion}`;
      return requestJson<HarnessProfileDetailResponse>(
        `/api/harness-profiles/${encodeURIComponent(profileId)}${query}`,
        options,
      );
    },
    create: (slug: string, draft: HarnessProfileDraftManifest) =>
      requestJson<HarnessProfileMutationResponse>(
        "/api/harness-profiles",
        jsonInit("POST", { slug, draft }),
      ),
    updateDraft: (
      profileId: string,
      body: { expectedRevision: number; draft: HarnessProfileDraftManifest },
    ) =>
      requestJson<HarnessProfileMutationResponse>(
        `/api/harness-profiles/${encodeURIComponent(profileId)}`,
        jsonInit("PATCH", body),
      ),
    publish: (profileId: string, expectedRevision: number) =>
      requestJson<HarnessProfilePublishResponse>(
        `/api/harness-profiles/${encodeURIComponent(profileId)}/publish`,
        jsonInit("POST", { expectedRevision }),
      ),
    fork: (profileId: string, slug: string, expectedRevision: number) =>
      requestJson<HarnessProfileMutationResponse>(
        `/api/harness-profiles/${encodeURIComponent(profileId)}/fork`,
        jsonInit("POST", { slug, expectedRevision }),
      ),
    restore: (profileId: string, version: number, expectedRevision: number) =>
      requestJson<HarnessProfileMutationResponse>(
        `/api/harness-profiles/${encodeURIComponent(profileId)}/restore`,
        jsonInit("POST", { version, expectedRevision }),
      ),
    archive: (profileId: string, expectedRevision: number) =>
      requestJson<HarnessProfileMutationResponse>(
        `/api/harness-profiles/${encodeURIComponent(profileId)}/archive`,
        jsonInit("POST", { expectedRevision }),
      ),
    unarchive: (profileId: string, expectedRevision: number) =>
      requestJson<HarnessProfileMutationResponse>(
        `/api/harness-profiles/${encodeURIComponent(profileId)}/unarchive`,
        jsonInit("POST", { expectedRevision }),
      ),
    remove: (profileId: string, expectedRevision: number) =>
      requestJson<{ deleted: true }>(
        `/api/harness-profiles/${encodeURIComponent(profileId)}/remove`,
        jsonInit("POST", { expectedRevision }),
      ),
    refreshSkill: (
      profileId: string,
      expectedRevision: number,
      artifactHash: string,
    ) =>
      requestJson<HarnessSkillRefreshResponse>(
        `/api/harness-profiles/${encodeURIComponent(profileId)}/skills/refresh`,
        jsonInit("POST", { expectedRevision, artifactHash }),
      ),
  },

  harnessSkills: {
    local: (options?: BrowserRequestOptions) =>
      requestJson<HarnessLocalSkillDiscoveryResponse>(
        "/api/harness-skills/local",
        options,
      ),
    discover: (body: HarnessSkillDiscoverRequest) =>
      requestJson<HarnessSkillDiscoveryResponse>(
        "/api/harness-skills/discover",
        jsonInit("POST", body),
      ),
    import: (body: HarnessSkillImportRequest) =>
      requestJson<HarnessSkillImportResponse>(
        "/api/harness-skills/import",
        jsonInit("POST", body),
      ),
    importLocal: (body: HarnessLocalSkillImportRequest) =>
      requestJson<HarnessSkillImportResponse>(
        "/api/harness-skills/local",
        jsonInit("POST", body),
      ),
  },

  integrations: {
    list: (options?: BrowserRequestOptions) =>
      requestJson<IntegrationsListResponse>("/api/integrations", {
        cache: "no-store",
        ...options,
      }),
    /** The 409 naming the version the integration actually sits at is the
     *  answer to `expectedVersion`, not a failure: a second tab is told that
     *  somebody else saved and keeps what was typed, so the body is read as
     *  data rather than as an error message. */
    save: (id: string, body: IntegrationConnectionSaveRequest) =>
      requestJson<
        IntegrationMutationResponse | IntegrationVersionConflict,
        IntegrationVersionConflict
      >(
        `/api/integrations/${encodeURIComponent(id)}/connection`,
        // The command is said out loud. The route no longer infers a write
        // from its absence, so a preview that lost this field is refused
        // rather than carried out.
        jsonInit("PUT", { ...body, preview: "write" }),
        (status) => status === 200 || status === 409,
      ),
    /** Read the named workflows and live runs before a connection change. The
     *  existing connection transport carries this read-only preview so the
     *  candidate secret never appears in a URL or leaves the authenticated
     *  request path. */
    previewImpact: (id: string, body: IntegrationImpactPreviewRequest) =>
      requestJson<IntegrationImpactPreviewResponse>(
        `/api/integrations/${encodeURIComponent(id)}/connection`,
        jsonInit("PUT", body),
      ),
    /** Tests what is live, whichever source it comes from, and carries no body:
     *  a test of values the request supplied would prove nothing about the
     *  connection a run will use. */
    test: (id: string) =>
      requestJson<IntegrationMutationResponse>(
        `/api/integrations/${encodeURIComponent(id)}/test`,
        { method: "POST" },
      ),
    setEnabled: (id: string, enabled: boolean) =>
      requestJson<IntegrationMutationResponse>(
        `/api/integrations/${encodeURIComponent(id)}/enabled`,
        jsonInit("PATCH", { enabled }),
      ),
    setSource: (id: string, source: IntegrationSource) =>
      requestJson<IntegrationMutationResponse>(
        `/api/integrations/${encodeURIComponent(id)}/source`,
        jsonInit("PATCH", { source }),
      ),
    disconnect: (id: string) =>
      requestJson<IntegrationMutationResponse>(
        `/api/integrations/${encodeURIComponent(id)}/connection`,
        { method: "DELETE" },
      ),
  },

  invites: {
    create: (email: string) =>
      requestJson<DashboardInviteResponse>(
        "/api/invites",
        jsonInit("POST", { email, role: "member" }),
      ),
    resend: (id: string) =>
      requestJson<DashboardInviteResponse>(
        `/api/invites/${encodeURIComponent(id)}/resend`,
        { method: "POST" },
      ),
    cancel: (id: string) =>
      requestVoid(`/api/invites/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      }),
  },

  jsonSchema: {
    inspect: (source: string, options?: BrowserRequestOptions) =>
      requestJson<JsonSchemaAuthoringInspectionResponse>(
        "/api/json-schema/inspect",
        jsonInit("POST", { source }, { cache: "no-store", ...options }),
      ),
  },

  memory: {
    delete: (subjectKey: string, docPath: string) =>
      requestVoid(
        `/api/memory?subjectKey=${encodeURIComponent(subjectKey)}&docPath=${encodeURIComponent(docPath)}`,
        { method: "DELETE" },
      ),
  },

  /** Read only: the composed check configuration, which the editor's group
   *  picker reads to offer real group names. A repository's script groups are
   *  written through `repositoryCatalog.save`, with a reason. */
  prePrChecks: {
    get: (options?: BrowserRequestOptions) =>
      requestJson<PrePrChecksResponse>("/api/pre-pr-checks", options),
  },

  prompts: {
    list: (includeArchived = false) =>
      requestJson<PromptLibraryListResponse>(
        `/api/prompt-library${includeArchived ? "?includeArchived=1" : ""}`,
      ),
    detail: (id: number) =>
      requestJson<PromptLibraryDetailResponse>(`/api/prompt-library/${id}`),
    version: (id: number, version: number, options?: BrowserRequestOptions) =>
      requestJson<PromptLibraryVersionResponse>(
        `/api/prompt-library/${id}/versions/${version}`,
        options,
      ),
    usage: (id: number) =>
      requestJson<PromptLibraryUsageResponse>(`/api/prompt-library/${id}/usage`),
    create: (body: {
      name: string;
      body: string;
      slots?: PromptSlotDefinition[];
      description?: string;
      tags?: string[];
    }) =>
      requestJson<PromptLibraryDetailResponse>(
        "/api/prompt-library",
        jsonInit("POST", body),
      ),
    updateVersion: (id: number, body: { body: string; slots: PromptSlotDefinition[] }) =>
      requestJson<PromptLibrarySaveResponse>(
        `/api/prompt-library/${id}`,
        jsonInit("PUT", body),
      ),
    updateMeta: (
      id: number,
      body: { name: string; description: string | null; tags: string[] },
    ) =>
      requestJson<PromptLibraryDetailResponse>(
        `/api/prompt-library/${id}`,
        jsonInit("PATCH", body),
      ),
    archive: (id: number) =>
      requestJson<PromptLibraryDetailResponse>(`/api/prompt-library/${id}`, {
        method: "DELETE",
      }),
    restore: (id: number, version: number) =>
      requestJson<PromptLibrarySaveResponse>(
        `/api/prompt-library/${id}/restore`,
        jsonInit("POST", { version }),
      ),
  },

  repositories: {
    list: (options?: BrowserRequestOptions) =>
      requestJson<RepositoriesResponse>("/api/repositories", options),
  },

  repositoryCatalog: {
    list: (options?: BrowserRequestOptions) =>
      requestJson<RepositoryCatalogListResponse>("/api/repository-catalog", {
        cache: "no-store",
        ...options,
      }),
    entry: (id: number, options?: BrowserRequestOptions) =>
      requestJson<RepositoryCatalogEntryResponse>(`/api/repository-catalog/${id}`, {
        cache: "no-store",
        ...options,
      }),
    /** The 409 naming the version the profile actually sits at is the answer to
     *  `expectedProfileVersion`, not a failure: the screen reloads rather than
     *  retries, so it is taken as data and the caller reads `currentVersion`. */
    save: (id: number, body: RepositoryCatalogUpsertRequest) =>
      requestJson<
        RepositoryCatalogMutationResponse | RepositoryCatalogProfileConflict,
        RepositoryCatalogProfileConflict
      >(
        `/api/repository-catalog/${id}`,
        jsonInit("PUT", body),
        (status) => status === 200 || status === 409,
      ),
    /** The switch, and nothing else: it mints no profile version, so a run in
     *  flight never sees its checks configuration move because of it. */
    setEnabled: (id: number, enabled: boolean) =>
      requestJson<RepositoryCatalogMutationResponse>(
        `/api/repository-catalog/${id}/enabled`,
        jsonInit("PATCH", { enabled }),
      ),
    /** One page of the profile history, newest first. `before` takes the version
     *  number of the oldest row already held, the same cursor the MCP history
     *  tool pages by: rows are only appended, so a version number cannot shift
     *  under a reader the way an offset would. */
    versions: (id: number, before?: number, options?: BrowserRequestOptions) =>
      requestJson<RepositoryCatalogVersionsResponse>(
        `/api/repository-catalog/${id}/versions${
          before === undefined ? "" : `?before=${before}`
        }`,
        { cache: "no-store", ...options },
      ),
    /** The 409 naming the repositories the dialog has not acknowledged is the
     *  normal first answer, so it is accepted as data rather than treated as a
     *  failure with a message. The other 409 is the catalog that enables
     *  nothing, which carries `error: "no_enabled_repository"` and a sentence
     *  rather than a population. */
    activate: (acknowledgedRepositoryKeys: string[], reason: string) =>
      requestJson<
        | RepositoryCatalogActivateResponse
        | RepositoryCatalogActivateConflict
        | RepositoryCatalogActivateBlocked,
        RepositoryCatalogActivateConflict
      >(
        "/api/repository-catalog/activate",
        jsonInit("POST", { acknowledgedRepositoryKeys, reason }),
        (status) => status === 200 || status === 409,
      ),
    /** The suggestion attempts this repository has spent, newest first. Cursor
     *  paginated: the caller passes back `nextCursor` and never an offset, so a
     *  row written between two pages cannot shift the page boundary. */
    suggestions: (id: number, cursor?: string | null, options?: BrowserRequestOptions) =>
      requestJson<RepositoryCatalogSuggestionsResponse>(
        `/api/repository-catalog/${id}/suggestions${
          cursor === undefined || cursor === null
            ? ""
            : `?cursor=${encodeURIComponent(cursor)}`
        }`,
        { cache: "no-store", ...options },
      ),
    importPreview: (options?: BrowserRequestOptions) =>
      requestJson<RepositoryCatalogImportPreviewResponse>(
        "/api/repository-catalog/import-preview",
        jsonInit("POST", {}, { cache: "no-store", ...options }),
      ),
    import: (repositoryKeys: string[], enabled: boolean) =>
      requestJson<RepositoryCatalogImportResponse>(
        "/api/repository-catalog/import",
        jsonInit("POST", { repositoryKeys, enabled }),
      ),
    /** The one call that waits on a model. The 429 carries the wait, so it is
     *  accepted as data the way the activation conflict is. */
    suggest: (repositoryId: number, options?: BrowserRequestOptions) =>
      requestJson<
        RepositoryCatalogSuggestResponse | RepositoryCatalogSuggestRateLimited,
        RepositoryCatalogSuggestError | { statusMessage?: string; message?: string }
      >(
        "/api/repository-catalog/suggest",
        jsonInit("POST", { repositoryId }, options),
        (status) => status === 200 || status === 429,
      ),
  },

  runs: {
    search: (query: string) =>
      requestJson<RunSearchResponse, RunSearchResponse>(
        `/api/runs/search?q=${encodeURIComponent(query)}`,
      ),
    replay: (
      runId: string,
      limit: 100 | 200,
      cursor?: string,
      options?: BrowserRequestOptions,
    ) =>
      requestJson<WorkflowRunReplayResponse>(
        `/api/runs/${encodeURIComponent(runId)}/replay?limit=${limit}${
          cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`
        }`,
        options,
      ),
    attempt: (
      runId: string,
      attemptId: number,
      options?: BrowserRequestOptions,
    ) =>
      requestJson<WorkflowReplayAttemptDetail | null>(
        `/api/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(String(attemptId))}`,
        options,
        undefined,
        () => null,
      ),
    cancel: (runId: string, options?: BrowserRequestOptions) =>
      requestJson<RunCancelResponse>(
        `/api/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST", ...options },
        (status) => status === 200 || status === 409,
      ),
  },

  /**
   * What an agent was sent, one send at a time (agent briefings). Every body is
   * returned unparsed: `lib/agent-visibility/contract.ts` reads it, so a newer
   * worker's record degrades to a sentence instead of a crash.
   */
  briefings: {
    /** The sends of one Block Attempt, with why any are missing. */
    attempt: (
      runId: string,
      filter: { nodeId: string; attempt: number; activationScopeId: string },
      page: ListPageRequest = {},
      options?: BrowserRequestOptions,
    ) =>
      requestJson<unknown>(
        withParams(`/api/runs/${encodeURIComponent(runId)}/briefings`, { ...filter, ...page }),
        options,
      ),
    sections: (runId: string, briefingId: string, page: ListPageRequest = {}, options?: BrowserRequestOptions) =>
      requestJson<unknown>(withParams(briefingPath(runId, briefingId, "sections"), { ...page }), options),
    /** One page of a section's stored text, from a UTF-8 byte offset. */
    sectionText: (
      runId: string,
      briefingId: string,
      sectionIndex: number,
      offset: number,
      options?: BrowserRequestOptions,
    ) =>
      requestJson<unknown>(
        withParams(briefingPath(runId, briefingId, `sections/${sectionIndex}`), { offset }),
        options,
      ),
    parts: (runId: string, briefingId: string, sectionIndex: number, page: ListPageRequest = {}, options?: BrowserRequestOptions) =>
      requestJson<unknown>(
        withParams(briefingPath(runId, briefingId, `sections/${sectionIndex}/parts`), { ...page }),
        options,
      ),
    spans: (runId: string, briefingId: string, sectionIndex: number, page: ListPageRequest = {}, options?: BrowserRequestOptions) =>
      requestJson<unknown>(
        withParams(briefingPath(runId, briefingId, `sections/${sectionIndex}/spans`), { ...page }),
        options,
      ),
    repositoryContext: (runId: string, briefingId: string, page: ListPageRequest = {}, options?: BrowserRequestOptions) =>
      requestJson<unknown>(withParams(briefingPath(runId, briefingId, "repository-context"), { ...page }), options),
    unresolvedSources: (runId: string, briefingId: string, page: ListPageRequest = {}, options?: BrowserRequestOptions) =>
      requestJson<unknown>(withParams(briefingPath(runId, briefingId, "unresolved-sources"), { ...page }), options),
  },

  settings: {
    /** One key's recorded changes. The listing already carries the newest one,
     *  so this is only fetched when a history drawer is opened. */
    history: (key: string, options?: BrowserRequestOptions) =>
      requestJson<SettingsVersionsResponse>(
        `/api/settings?key=${encodeURIComponent(key)}`,
        options,
      ),
    update: (body: SettingsPatchRequest) =>
      requestJson<SettingsPatchResponse>("/api/settings", jsonInit("PATCH", body)),
  },

  systemHealth: {
    scan: (signal: AbortSignal) =>
      requestJson<SystemHealthResponse | null, { error?: unknown }>(
        "/api/system-health",
        { method: "POST", signal },
        undefined,
        () => null,
      ),
  },

  users: {
    changeRole: (userId: string, role: "admin" | "member") =>
      requestVoid(
        `/api/users/${encodeURIComponent(userId)}/role`,
        jsonInit("PATCH", { role }),
      ),
  },

  /** The repository record of a subject and its repository questions, as
   *  rounds. Bodies are returned unparsed for `lib/agent-visibility/contract.ts`. */
  workScope: {
    /** Rounds are opt-in on the worker, so a caller from before they existed
     *  keeps its inline answer. This dashboard always wants them. */
    get: (subjectKey: string, roundsCursor: string | null = null, options?: BrowserRequestOptions) =>
      requestJson<unknown>(withParams("/api/work-scope", { subjectKey, rounds: "true", roundsCursor }), options),
    deliveries: (
      subjectKey: string,
      roundId: string,
      page: ListPageRequest = {},
      options?: BrowserRequestOptions,
    ) =>
      requestJson<unknown>(
        withParams(`/api/work-scope/rounds/${encodeURIComponent(roundId)}/deliveries`, { subjectKey, ...page }),
        options,
      ),
    effects: (subjectKey: string, roundId: string, page: ListPageRequest = {}, options?: BrowserRequestOptions) =>
      requestJson<unknown>(
        withParams(`/api/work-scope/rounds/${encodeURIComponent(roundId)}/effects`, { subjectKey, ...page }),
        options,
      ),
    /** A person's change to the record. `expectedVersion` is the version they
     *  read: the worker refuses a stale one rather than overwriting, and there
     *  is no force flag to offer. */
    edit: (body: {
      subjectKey: string;
      expectedVersion: number;
      changes: { repositoryKey: string; action: "select" | "exclude" | "remove"; rationale?: string }[];
    }) => requestJson<unknown>("/api/work-scope", jsonInit("PATCH", body)),
  },

  workflowDefinitions: {
    detail: (id: number) =>
      requestJson<WorkflowDefinitionDetailResponse>(`/api/workflow-definitions/${id}`),
    create: (body: {
      name: string;
      source:
        | { kind: "template"; templateId: string }
        | { kind: "duplicate"; definitionId: number };
    }) =>
      requestJson<WorkflowDefinitionDetailResponse>(
        "/api/workflow-definitions",
        jsonInit("POST", body),
      ),
    save: (
      id: number,
      definition: WorkflowDefinition,
      expectedDraftRevision: number,
    ) =>
      requestJson<WorkflowDefinitionSaveResponse>(
        `/api/workflow-definitions/${id}`,
        jsonInit("PUT", { definition, expectedDraftRevision }),
      ),
    patch: (id: number, body: { name?: string; enabled?: boolean }) =>
      requestJson<WorkflowDefinitionMeta>(
        `/api/workflow-definitions/${id}`,
        jsonInit("PATCH", body),
      ),
    delete: (id: number) =>
      requestVoid(`/api/workflow-definitions/${id}`, { method: "DELETE" }),
    validate: (
      id: number,
      definition: WorkflowDefinition,
      options?: BrowserRequestOptions,
    ) =>
      requestJson<WorkflowDefinitionValidationResponse>(
        `/api/workflow-definitions/${id}/validate`,
        jsonInit("POST", { definition }, options),
      ),
    saveLayout: (
      id: number,
      layout: WorkflowDefinitionLayout,
      expectedLayoutRevision: number,
    ) =>
      requestJson<WorkflowDefinitionLayoutResponse>(
        `/api/workflow-definitions/${id}/layout`,
        jsonInit("PATCH", { layout, expectedLayoutRevision }),
      ),
    deploy: (
      id: number,
      expectedDraftRevision: number,
      expectedDeployedVersion: number | null,
    ) =>
      requestJson<
        WorkflowDefinitionDeploymentResponse,
        WorkflowDefinitionDeploymentValidationResponse
      >(
        `/api/workflow-definitions/${id}/deploy`,
        jsonInit("POST", { expectedDraftRevision, expectedDeployedVersion }),
      ),
    rollback: (
      id: number,
      version: number,
      expectedDeployedVersion: number | null,
    ) =>
      requestJson<WorkflowDefinitionDeploymentResponse>(
        `/api/workflow-definitions/${id}/rollback`,
        jsonInit("POST", { version, expectedDeployedVersion }),
      ),
    catalog: (
      id: number,
      definition: WorkflowDefinition,
      options?: BrowserRequestOptions,
    ) =>
      requestJson<WorkflowDefinitionCatalogResponse>(
        `/api/workflow-definitions/${id}/catalog`,
        jsonInit("POST", { definition }, options),
      ),
    promptPreview: (
      id: number,
      definition: WorkflowDefinition,
      blockId: string,
      options?: BrowserRequestOptions,
    ) =>
      requestJson<EffectivePromptPreviewResponse>(
        `/api/workflow-definitions/${id}/prompt-preview`,
        jsonInit("POST", { definition, blockId }, { cache: "no-store", ...options }),
      ),
    /** What this block last put in front of a model, over every run of this
     *  definition, or the reason there is none. Read, not authored: it says
     *  nothing about the unsaved definition in the editor. */
    nodeLastBriefing: (id: number, nodeId: string, options?: BrowserRequestOptions) =>
      requestJson<unknown>(
        `/api/workflow-definitions/${id}/nodes/${encodeURIComponent(nodeId)}/last-briefing`,
        { cache: "no-store", ...options },
      ),
  },

  triggers: {
    manualDispatchPreflight: (
      definitionId: number,
      nodeId: string,
      input: ManualDispatchInput,
    ) =>
      requestJson<ManualDispatchPreflightResponse>(
        definitionTriggerPath(definitionId, nodeId, "manual-dispatch/preflight"),
        jsonInit("POST", input),
      ),
    manualDispatch: (
      definitionId: number,
      nodeId: string,
      body: ManualDispatchRequest,
    ) =>
      requestJson<ManualDispatchResponse>(
        definitionTriggerPath(definitionId, nodeId, "manual-dispatch"),
        jsonInit("POST", body),
      ),
    rejections: (
      definitionId: number,
      nodeId: string,
      options?: BrowserRequestOptions,
    ) =>
      requestJson<{ rejectionsToday?: WebhookRejectionSummaryEntry[] }>(
        definitionTriggerPath(definitionId, nodeId, "rejections"),
        options,
      ),
    webhookConfig: (
      definitionId: number,
      nodeId: string,
      options?: BrowserRequestOptions,
    ) =>
      requestJson<WebhookEndpointConfigResponse>(
        definitionTriggerPath(definitionId, nodeId, "webhook/config"),
        options,
      ),
    webhookDeliveries: (
      definitionId: number,
      nodeId: string,
      options?: BrowserRequestOptions,
    ) =>
      requestJson<WebhookDeliveriesResponse>(
        definitionTriggerPath(definitionId, nodeId, "webhook/deliveries"),
        options,
      ),
    webhookAction: (
      definitionId: number,
      nodeId: string,
      action: "reveal" | "rotate" | "revoke" | "unrevoke",
      body: { force?: true },
      options?: BrowserRequestOptions,
    ) =>
      requestJson<WebhookActionResponse>(
        definitionTriggerPath(definitionId, nodeId, `webhook/${action}`),
        jsonInit("POST", body, options),
      ),
    webhookSetSecret: (
      definitionId: number,
      nodeId: string,
      body: WebhookSetSecretRequest,
      options?: BrowserRequestOptions,
    ) =>
      requestJson<WebhookSetSecretResponse>(
        definitionTriggerPath(definitionId, nodeId, "webhook/set-secret"),
        jsonInit("POST", body, options),
      ),
    webhookTestDelivery: (
      definitionId: number,
      nodeId: string,
      body: WebhookTestDeliveryRequest,
      options?: BrowserRequestOptions,
    ) =>
      requestJson<WebhookTestDeliveryResponse>(
        definitionTriggerPath(definitionId, nodeId, "webhook/test-delivery"),
        jsonInit("POST", body, options),
      ),
    scheduleConfig: (
      definitionId: number,
      nodeId: string,
      options?: BrowserRequestOptions,
    ) =>
      requestJson<ScheduleConfigResponse>(
        definitionTriggerPath(definitionId, nodeId, "schedule/config"),
        options,
      ),
    schedulePause: (
      definitionId: number,
      nodeId: string,
      options?: BrowserRequestOptions,
    ) =>
      requestJson<SchedulePauseResponse>(
        definitionTriggerPath(definitionId, nodeId, "schedule/pause"),
        jsonInit("POST", {}, options),
      ),
    scheduleResume: (
      definitionId: number,
      nodeId: string,
      options?: BrowserRequestOptions,
    ) =>
      requestJson<ScheduleResumeResponse>(
        definitionTriggerPath(definitionId, nodeId, "schedule/resume"),
        jsonInit("POST", {}, options),
      ),
    schedulePreview: (
      definitionId: number,
      nodeId: string,
      body: SchedulePreviewRequest,
      options?: BrowserRequestOptions,
    ) =>
      requestJson<SchedulePreviewResponse>(
        definitionTriggerPath(definitionId, nodeId, "schedule/preview"),
        jsonInit("POST", body, options),
      ),
  },
} as const;

export type CancelRunResult =
  | { outcome: "cancelled" }
  | { outcome: "already_terminal" }
  | { outcome: "unconfirmed" }
  | { outcome: "forbidden" }
  | { outcome: "not_found" }
  | { outcome: "error" };

export async function cancelRun(runId: string): Promise<CancelRunResult> {
  try {
    const result = await apiClient.runs.cancel(runId);
    if (!result.ok) {
      if (result.status === 403) return { outcome: "forbidden" };
      if (result.status === 404) return { outcome: "not_found" };
      return { outcome: "error" };
    }
    return result.data.outcome === "cancelled" ||
      result.data.outcome === "already_terminal" ||
      result.data.outcome === "unconfirmed"
      ? { outcome: result.data.outcome }
      : { outcome: "error" };
  } catch {
    return { outcome: "error" };
  }
}
