# AI Workflow Remote MCP: architecture design

**Date:** 2026-08-11  
**Status:** approved direction for planning, no implementation  
**Scope:** internal dogfooding, the Artur/Arthur AI release pipeline, and dedicated customer deployments

## 1. Goal and success criterion

AI Workflow exposes a stateless Remote MCP on every worker at the canonical address `https://<worker-host>/mcp`. An agent connected from Claude Code, Codex, or another compliant client can carry out the full work cycle without the dashboard and without manually reading logs:

1. find, create, and edit a ticket, add a comment, or safely change its status;
2. find a ticket's runs, observe their state, trace, and result, and obtain a deterministic diagnosis;
3. create a workflow, edit a draft with version control, validate a graph with branches and loops, publish, roll back, and dispatch;
4. manage harness profiles, skills, and pins to workflow blocks;
5. read memory and perform controlled, auditable updates and deletions;
6. run and retrieve results of automated dogfooding tests.

Success means the same MCP contract passes contract tests on the internal worker, in an Artur release preview, and after deployment to a dedicated customer worker. The dashboard is not part of the critical path.

## 2. Current state and resulting constraints

Repository analysis shows the following state:

- `apps/worker` is a Nitro/Vercel worker with the Durable Workflow DevKit, Neon Postgres/Drizzle, Vercel Sandbox, and integration adapters. This is where `/api/v1/*`, workflow execution, and data access run.
- `apps/dashboard` is a separate Next.js deployment and calls the worker server-to-server. MCP should not depend on the dashboard.
- `apps/shared/contracts` holds shared domain contracts.
- Better Auth `1.6.20` supports bearer sessions, organizations, and external SSO via `@better-auth/sso`. AI Workflow is currently an OIDC client, not an authorization server for external MCP clients.
- `/api/v1/*` requires a valid session. `requireDashboardActor()` binds the user to the organization designated by `DASHBOARD_ORG_SLUG`; roles are `owner`, `admin`, `member`.
- Workflow definitions have a draft revision, a deployed version, validation, publish/deploy, rollback, restore, and a v2 graph supporting branches and loops.
- Harness profiles have an organization, a draft, immutable published versions, a capability catalog, and skill import/refresh.
- Memory has limits and version control in the store, but the public API does not yet provide a full safe update flow.
- Run observability has execution log sanitization and data for diagnosis, but there is no shared append-only audit log for all MCP mutations.
- The release is two-stage: the source workflow `prepare-artur-release.yml` and `sync-artur-release.yml` create a complete snapshot in the destination repository; the destination repo validates, publishes, waits for Vercel deployments, runs smoke tests, and writes `release-manifest.json`. Existing files and the repo use the spelling `Artur`; a business document may say Arthur AI, but the automation keeps the existing names.
- The internal dogfooding target is the existing worker `ai-workflow-app`. The `ai-workflow-demo` deployment is out of scope.

We do not assume the names of existing secrets or environment names other than those read from repo/deployment metadata. Every new configuration described below is explicitly a new proposal.

## 3. Options considered

### Option A: MCP embedded in the worker (chosen)

The `/mcp` endpoint runs inside `apps/worker`, using the existing application services, the same database, adapters, and Better Auth directly. It is stateless and has its own policy/audit/idempotency boundaries.

Advantages: the thinnest layer, no token passthrough, no new service-to-service secret, shared transactions, and a natural entry point into the current release snapshot. Cost: MCP shares the worker's blast radius and scaling, so it requires limits, timeouts, and a feature flag.

### Option B: a separate `apps/mcp`

A separate deployment would call the worker over HTTP. It gives independent scaling but duplicates authorization, RBAC, idempotency, and auditing; it adds a deployment, secrets, and the risk of contract drift. Rejected at this stage.

### Option C: a generated MCP facade over REST/OpenAPI

The fastest way to get many endpoints, but it does not properly model preview/confirm, CAS, traces, trust boundaries, or workflow semantics. Rejected as insufficiently safe.

## 4. Target architecture

```text
Claude Code / Codex / MCP client
        │ OAuth 2.1 + PKCE / client_credentials for smoke
        ▼
https://<dedicated-worker>/mcp  (Streamable HTTP, stateless)
        │
        ├── MCP transport + schema validation + bounded output
        ├── OAuth token verification + actor/tenant context
        ├── RBAC/scope policy + rate limits
        ├── safe mutation coordinator (CAS + preview/confirm)
        ├── idempotency store + append-only audit
        │
        └── thin tool adapters
                ├── issue-tracker application service
                ├── run registry / run observability
                ├── workflow-definition store / manual dispatch
                ├── harness-profile store / skills
                ├── memory store
                └── dogfood test runner
```

### 4.1 Transport

- Stable protocol: MCP `2025-11-25`.
- Transport: Streamable HTTP only, under `/mcp`; no legacy HTTP+SSE.
- `POST /mcp` handles JSON-RPC. `GET /mcp` and `DELETE /mcp` return `405`, because the server does not maintain a transport session or server-initiated notifications.
- Every request is self-contained. We do not store `Mcp-Session-Id`, which removes the session-routing problem across Vercel instances and prepares the migration to the planned sessionless protocol version.
- Maximum request body, execution time, and maximum result size are set per deployment. Large logs, traces, and lists always use cursor pagination.
- Responses include `requestId`, `serverVersion`, `contractHash`, and a safe `traceId` in `_meta` with its own reverse-DNS namespace; no tokens or secrets.

MCP `2025-11-25` requires RFC 9728 from the HTTP resource server, audience binding, and forbids token passthrough. Streamable HTTP replaces the old HTTP+SSE transport. Sources: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

### 4.2 OAuth

The worker becomes both an OAuth Authorization Server and an MCP Resource Server:

- `@better-auth/oauth-provider@1.6.20` extends the existing Better Auth without a separate account system.
- Interactive users use Authorization Code + PKCE S256. The agent inherits the `userId`, organization, and role of the user who granted consent.
- `client_credentials` is allowed only for pre-created confidential clients used by smoke/dogfood automation. Each such client has a fixed organization and the smallest set of scopes.
- Public Claude Code/Codex clients are pre-registered or registered via DCR according to deployment policy. Untrusted anonymous registration is disabled by default on customer deployments.
- The canonical resource/audience is exactly `https://<worker-host>/mcp`; a token for another host, path, or deployment is rejected.
- `/.well-known/oauth-protected-resource/mcp` returns RFC 9728 metadata. A `401` from `/mcp` includes `WWW-Authenticate` with `resource_metadata` and the minimal scope. Authorization Server metadata and OIDC discovery are also served by the Better Auth handler on the well-known paths required for issuers with a path component.
- CORS exposes `WWW-Authenticate` only to explicitly allowed origins; callback URIs are compared exactly.
- The worker never forwards the MCP token to Jira, GitHub, GitLab, or a model provider. It uses only the given deployment's own credentials.

The Better Auth OAuth Provider declares OAuth 2.1, PKCE, JWT/JWKS, discovery, DCR, and a resource-server helper for MCP: [Better Auth OAuth Provider](https://better-auth.com/docs/plugins/oauth-provider).

### 4.3 Tenant isolation

The primary customer boundary is the dedicated deployment: a separate worker host, database, and integration credentials. Defense in depth remains mandatory:

- tools do not accept `tenantId` or `organizationId` from the model;
- tenant/actor context is derived solely from the verified token and membership in the given deployment's `DASHBOARD_ORG_SLUG`;
- every new MCP query and table includes `organization_id`; reads and writes always filter by it;
- for existing stores that look globally scoped, the MCP facade checks the deployment organization before calling through, and migrations to full org scoping are part of the domain increments;
- cache, idempotency key, and confirmation token are namespaced by deployment, organization, actor, client, and tool.

### 4.4 Code layers

1. **Transport** maps the H3 request/response onto the MCP SDK; it contains no domain logic.
2. **Request context** verifies the token, audience, membership, role, and scope; it creates an immutable `McpActorContext`.
3. **Tool registry** registers the Zod input/output schema and annotations, and delegates to the domain facade.
4. **Policy** is the single place that maps tool → scopes → roles → mutation class.
5. **Safety coordinator** handles CAS, preview/confirm, and the canonical payload hash.
6. **Idempotency** guarantees an exactly-once visible outcome for repeated mutations within a given window.
7. **Audit** records redacted metadata regardless of whether the operation succeeded.
8. **Application services** remain the source of truth; MCP does not replicate Jira rules, workflow lifecycle, harness, or memory logic.

## 5. Authorization, RBAC, and safe mutations

### 5.1 Scopes

| Scope | Meaning |
|---|---|
| `mcp:read` | capabilities, tickets, runs, workflows, profiles, skills, memory metadata/content after redaction |
| `tickets:write` | create/edit/comment/labels/transition |
| `runs:dispatch` | preflight and dispatching a workflow |
| `runs:control` | cancel/replay |
| `workflows:write` | create and draft edits |
| `workflows:publish` | publish, rollback, enable/archive |
| `harness:write` | profile drafts, skills, and assignments |
| `memory:write` | update memory |
| `memory:delete` | hard delete memory |
| `dogfood:run` | run the mutation-canary suite |

### 5.2 Role mapping

| Operation | member | admin | owner | service client |
|---:|---:|---:|---:|
| Read data after redaction | yes | yes | yes | per scope |
| Ticket write, dispatch | no | yes | yes | per scope |
| Workflow/harness draft | no | yes | yes | no by default |
| Publish/rollback/run control | no | yes | yes | explicit scope only |
| Memory update | no | yes | yes | no by default |
| Memory delete | no | no | yes | no |
| Mutation dogfood suite | no | yes | yes | yes, limited to canary fixtures |

Authorization requires both a role and a scope. A scope does not elevate a role, and a role does not substitute for a scope.

### 5.3 Mutation classes

**Class R (direct, reversible):** create/update draft, comment, labels, dispatch after a successful preflight. Requires an `idempotencyKey` and the matching `expectedRevision`, `expectedVersion`, `expectedStatusId`, or `expectedContentDigest`.

**Class C (preview/confirm):** ticket transition, workflow publish/rollback/archive, run cancel/replay, profile publish, skill import/refresh that changes the active artifact, memory update, and memory delete. Preview returns a deterministic diff/effects and a one-time `confirmationToken` valid for 5 minutes. Confirm must submit that token along with the same `idempotencyKey`.

The confirmation token is bound to: the deployment, `organizationId`, `actorId`, `clientId`, the tool name, the canonical input hash, the resource's current version, and an expiry time. It is single-use. A state change after preview causes `CONFLICT`, not automatic execution against the new state.

### 5.4 Idempotency

The `mcp_idempotency_keys` table has a uniqueness constraint on `(organization_id, actor_subject, client_id, tool_name, idempotency_key)`. A record stores the input hash, the state `started|completed|failed`, the safe outcome, and a 24h expiry.

- the same key and the same payload return the previous result;
- the same key and a different payload return `IDEMPOTENCY_CONFLICT`;
- a timeout after an ambiguous result is resolved by a domain read before retrying;
- read tools do not require a key.

### 5.5 Audit log

The append-only `mcp_audit_events` table retains records for 365 days, with the period configurable per deployment:

- request/trace ID, timestamp, server version, and contract hash;
- actor subject, client ID, organization ID, role, and the scopes used;
- tool, mutation class, target references, outcome/error code, latency;
- input and output hash, idempotency key hash, and confirmation ID;
- redacted effect metadata, never access/refresh tokens, client secrets, full comments, logs, or memory content.

The retention job deletes only records older than the configured period and itself generates a metric, not an audit event per row.

## 6. Protection against prompt injection and data leakage

Ticket content, comments, attachment metadata, logs, trace attributes, skill files, and memory are treated as `external_untrusted`, even when they come from an internal system.

- Raw content never goes into a tool description, a system error, or server instructions.
- Results have separate `data`, `trust`, `contentDigest`, `truncated`, `redactions`, and cursor fields.
- By default, a summary and structured evidence are returned. Full comments/log chunks require an explicit parameter, permission, and limit.
- The sanitizer strips known secrets, auth headers, token-like values, and control characters before serialization and before logging.
- `runs.diagnose` is a deterministic classifier over redacted events. It does not run a hidden LLM that could execute an instruction embedded in a log.
- No mutation accepts an entire prior result as an opaque payload. Every target and change goes through the Zod schema, canonicalization, policy, and CAS.
- URLs fetched by skill discovery/import are subject to a host allowlist, private-IP/redirect SSRF blocking, and size limits.
- MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) describe risk to the client, but never substitute for server-side control.

## 7. Shared tool contract

Every tool returns:

```ts
type McpEnvelope<T> = {
  data: T;
  meta: {
    requestId: string;
    traceId: string;
    serverVersion: string;
    contractHash: string;
    trust: "system" | "tenant" | "external_untrusted";
    truncated: boolean;
    redactions: number;
    nextCursor?: string;
  };
};
```

Errors use fixed codes: `UNAUTHENTICATED`, `INSUFFICIENT_SCOPE`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `CONFIRMATION_REQUIRED`, `CONFIRMATION_EXPIRED`, `RATE_LIMITED`, `DEPENDENCY_UNAVAILABLE`, `INTERNAL_ERROR`. The message is safe to show the model; detail goes only into redacted logs keyed by `requestId`.

Lists accept a `limit` in the range `1..100` and an opaque `cursor`. Identifiers are strings with length limits. Timestamps are UTC ISO-8601. Versions and revisions are integers, and digests have the form `sha256:<hex>`.

## 8. MCP catalog

The names below are a public, versioned contract. Input omits `organizationId`; context comes from the token.

### 8.1 System

| Tool | Input | Output / notes |
|---|---|---|
| `system.capabilities` | `{}` | protocol/server version, contract hash, deployment class, enabled domains, read scopes |
| `system.schemas` | `{name: "workflow-v2"|"harness-profile"|"tool-catalog"}` | versioned JSON Schema and digest |

### 8.2 Tickets

| Tool | Input | Output / mutation |
|---|---|---|
| `tickets.search` | `{query, limit?, cursor?}` | ticket summaries; external untrusted |
| `tickets.get` | `{ticketKey, includeComments?, commentsLimit?}` | fields, status, labels, redacted comments, and content digest |
| `tickets.create` | `{projectKey, summary, description?, issueType, labels?, idempotencyKey}` | Class R; created ticket |
| `tickets.update` | `{ticketKey, fields, expectedUpdatedAt, idempotencyKey}` | Class R; allowlist of editable fields |
| `tickets.comment` | `{ticketKey, body, idempotencyKey}` | Class R; comment ID and timestamp |
| `tickets.update_labels` | `{ticketKey, add?, remove?, expectedLabelsDigest, idempotencyKey}` | Class R; resulting label set |
| `tickets.preview_transition` | `{ticketKey, targetStatusId, expectedStatusId, idempotencyKey}` | diff and confirmation token |
| `tickets.confirm_transition` | `{confirmationToken, idempotencyKey}` | Class C; new status |
| `tickets.list_runs` | `{ticketKey, status?, limit?, cursor?}` | run summaries associated with the ticket |

### 8.3 Runs, traces, and results

| Tool | Input | Output / mutation |
|---|---|---|
| `runs.list` | `{workflowId?, ticketKey?, status?, createdAfter?, limit?, cursor?}` | run summaries |
| `runs.get` | `{runId}` | current status, workflow/version, attempt summary, result/error summary |
| `runs.get_attempt` | `{runId, attemptId}` | step/block statuses and redacted outcomes |
| `runs.trace` | `{runId, attemptId?, level?: "summary"|"detailed", cursor?, limit?}` | ordered spans/events, without raw secrets |
| `runs.result` | `{runId}` | typed final output, artifacts/references, and failure classification |
| `runs.diagnose` | `{runId, depth?: "summary"|"full"}` | deterministic diagnosis, evidence refs, and safe next actions |
| `runs.preview_cancel` | `{runId, expectedStatus, idempotencyKey}` | effect and confirmation token |
| `runs.confirm_cancel` | `{confirmationToken, idempotencyKey}` | Class C |
| `runs.preview_replay` | `{runId, attemptId?, expectedStatus, idempotencyKey}` | preflight replay and token |
| `runs.confirm_replay` | `{confirmationToken, idempotencyKey}` | Class C; new run/attempt ID |

MCP does not maintain subscriptions. The agent observes a run by polling `runs.get`; the response includes `pollAfterMs` and a terminal flag. This works correctly on stateless Vercel and does not require an event queue in the first slice.

### 8.4 Workflows

| Tool | Input | Output / mutation |
|---|---|---|
| `workflows.list` | `{state?, limit?, cursor?}` | definitions and versions |
| `workflows.get` | `{workflowId, version?: "draft"|number}` | graph v2 and lifecycle metadata |
| `workflows.create` | `{name, description?, definition?, idempotencyKey}` | Class R; draft revision 1 |
| `workflows.save_draft` | `{workflowId, definition, expectedDraftRevision, idempotencyKey}` | Class R; the full v2 schema supports branches and loops |
| `workflows.validate` | `{definition}` or `{workflowId, revision}` | errors/warnings with paths in the graph; no write |
| `workflows.preview_publish` | `{workflowId, expectedDraftRevision, expectedDeployedVersion, idempotencyKey}` | validation, version diff, and token |
| `workflows.confirm_publish` | `{confirmationToken, idempotencyKey}` | Class C; immutable deployed version |
| `workflows.restore_draft` | `{workflowId, sourceVersion, expectedDraftRevision, idempotencyKey}` | Class R |
| `workflows.preview_rollback` | `{workflowId, targetVersion, expectedDeployedVersion, idempotencyKey}` | diff and token |
| `workflows.confirm_rollback` | `{confirmationToken, idempotencyKey}` | Class C |
| `workflows.set_lifecycle` | preview/confirm for `{workflowId, action: "enable"|"disable"|"archive", expectedVersion}` | Class C |
| `workflows.dispatch_preflight` | `{workflowId, nodeId?, input, expectedDeployedVersion}` | resolved trigger/target, validation, and estimated scope |
| `workflows.dispatch` | `{workflowId, nodeId?, input, expectedDeployedVersion, preflightDigest, idempotencyKey}` | Class R; run ID and polling hint |

Branches and loops are not separate imperative tools. They are typed nodes/edges of `workflow-v2`; the validator checks reachability, allowed cycles, exit condition, max iterations, and bindings before save/publish.

### 8.5 Harness profiles and skills

| Tool | Input | Output / mutation |
|---|---|---|
| `harness.list_profiles` | `{state?, limit?, cursor?}` | profile summaries |
| `harness.get_profile` | `{profileId, version?: "draft"|number}` | manifest and capabilities |
| `harness.create_profile` | `{name, base?, idempotencyKey}` | Class R |
| `harness.save_draft` | `{profileId, manifest, expectedDraftRevision, idempotencyKey}` | Class R |
| `harness.validate` | `{manifest}` or `{profileId, revision}` | errors/warnings/capability gaps |
| `harness.preview_publish` / `harness.confirm_publish` | preview with profile/revisions; confirm with token | Class C |
| `harness.capabilities` | `{agentKind?, refresh?: false}` | cached capability catalog |
| `skills.search_remote` | `{provider, repository, query?, ref?, limit?, cursor?}` | allowlisted discovery, no write |
| `skills.list_local` | `{query?, limit?, cursor?}` | configured local sources |
| `skills.preview_import` / `skills.confirm_import` | source/ref/path/profile target + CAS; token | Class C, SSRF/content limits |
| `skills.preview_refresh` / `skills.confirm_refresh` | `{skillId, expectedDigest, targetProfileRevision, idempotencyKey}`; token | Class C |
| `harness.assign_profile` | `{workflowId, nodeId, profileId, profileVersion, expectedDraftRevision, idempotencyKey}` | Class R; atomic patch of the graph node |
| `harness.unassign_profile` | `{workflowId, nodeId, expectedDraftRevision, idempotencyKey}` | Class R |

### 8.6 Memory

| Tool | Input | Output / mutation |
|---|---|---|
| `memory.list` | `{scope?, repository?, limit?, cursor?}` | metadata, version, provenance, and digest |
| `memory.get` | `{memoryId, includeContent?: true}` | redacted content, provenance, version, and digest |
| `memory.preview_update` | `{memoryId, operation: "replace"|"merge", content, expectedVersion, expectedContentDigest, idempotencyKey}` | deterministic diff, policy warnings, and token |
| `memory.confirm_update` | `{confirmationToken, idempotencyKey}` | Class C; new version/digest |
| `memory.preview_delete` | `{memoryId, expectedVersion, expectedContentDigest, reason, idempotencyKey}` | effect and token |
| `memory.confirm_delete` | `{confirmationToken, idempotencyKey}` | Class C; owner only |

Memory content goes through secret scanning and a size check before preview. The audit stores only hash/diff statistics, not content.

### 8.7 Dogfood and system diagnostics

| Tool | Input | Output / mutation |
|---|---|---|
| `dogfood.list_suites` | `{}` | versioned suites and required scopes |
| `dogfood.run` | `{suite: "readonly"|"mutation-canary", fixtureSet, idempotencyKey}` | async test run ID; the mutation suite runs only against canary fixtures |
| `dogfood.get` | `{testRunId}` | status, checks, timings, redacted evidence, artifact refs |
| `dogfood.list` | `{status?, limit?, cursor?}` | test history for the deployment |

`mutation-canary` creates resources tagged with the run ID, does not touch normal tickets/workflows/memory, and cleans them up idempotently. Cleanup failure shows up as a separate check and alert.

## 9. MCP resources

A small set of read-only resources limits repeating large schemas in tool calls:

- `ai-workflow://schemas/workflow-definition/v2`;
- `ai-workflow://catalog/workflow-blocks`;
- `ai-workflow://catalog/harness-capabilities`;
- `ai-workflow://contracts/tools/<contractHash>`.

Resources go through the same auth/tenant policy as tools. MCP prompts are not published in the first version, so the server does not introduce instructions that compete with the host agent.

## 10. MCP data model

New tables are part of `apps/worker/src/db/schema.ts` and each one has `organization_id`:

- `mcp_idempotency_keys`: key, payload hash, state, safe response, expiry;
- `mcp_confirmation_intents`: tool/target/input hash, expected state, actor/client, expires, consumed timestamp;
- `mcp_audit_events`: append-only audit metadata;
- `mcp_dogfood_runs` and `mcp_dogfood_checks`: state of the asynchronous suites.

The OAuth Provider adds its own tables to `auth-schema.ts` following the schema of exactly the same package version as Better Auth. Migrations are expand-only in the release that introduces MCP. Old code can run against the new schema; an application rollback does not require a database rollback.

## 11. Observability and operations

### 11.1 Metrics and logs

- count/latency/error rate per tool, without `ticketKey` or content as metric labels;
- 401/403/409/429, idempotency replay/conflict, confirmation expired/consumed;
- response length and redaction count, dependency latency, and timeout;
- dogfood suite pass/fail/cleanup failure;
- OAuth authorize/token failures without logging the code/token/client secret.

The W3C `traceparent` is accepted with a format allowlist; the MCP request span is the parent of the application service and integration spans. `runs.trace` reads only traces belonging to the organization.

### 11.2 Health

- `/health` remains a simple liveness check.
- the new `/api/v1/system/mcp-readiness` is an internal/deployment smoke endpoint and checks the feature flag, schema floor, OAuth signing/JWKS, DB, and contract hash without exposing secrets.
- `system.capabilities` is the authorized MCP-level readiness/capability check.

### 11.3 Feature flags and limits

New, explicitly proposed env vars (not treated as already existing):

- `MCP_ENABLED`: kill switch, `false` by default outside dogfood;
- `MCP_SERVER_VERSION`: build SemVer, validated at startup;
- `MCP_AUDIT_RETENTION_DAYS`: `365` by default;
- `MCP_MAX_REQUEST_BYTES`, `MCP_MAX_RESULT_BYTES`, and `MCP_TOOL_TIMEOUT_MS`: bounded defaults;
- `MCP_READ_RATE_LIMIT_PER_MINUTE` and `MCP_MUTATION_RATE_LIMIT_PER_MINUTE`: per tenant/actor/client/tool, `120` and `20` by default respectively;
- `MCP_ALLOW_PUBLIC_DCR`: `false` by default; internal dogfood may explicitly allow only public clients with PKCE S256 and safe HTTPS/loopback redirect URIs, and customer deployments start from pre-registration;
- `MCP_DOGFOOD_FIXTURE_PREFIX`: isolated canary prefix.

OAuth smoke client secrets are not given names in the spec as "existing." The pipeline has a separate discovery/configuration step and creates new GitHub Environment secrets only after the destination repo's policy is confirmed.

## 12. Versioning and compatibility

- `MCP_SERVER_VERSION` uses SemVer independently of the Artur release's calendar version.
- `serverInfo.version`, `system.capabilities`, and the release manifest show the same version.
- `contractHash` is the SHA-256 of the canonical JSON of all names, input/output schemas, annotations, and error codes.
- Additive tool changes and optional fields are minor; fixes with no contract change are patch; removing or changing the meaning of a tool or a required field requires major.
- Deprecation lasts a minimum of two consecutive Artur releases and is reported in capabilities and tool metadata.
- The worker supports the stable MCP `2025-11-25`. Version `2026-07-28` will be added only after it reaches stable status and passes the client matrix; the stateless design minimizes the migration scope.
- The release manifest records the minimum DB schema revision and the compatible product release range.

## 13. Test strategy

### 13.1 Unit

- schema validation and canonical hashing;
- role + scope matrix, audience, and organization binding;
- idempotency replay/conflict/concurrent start;
- preview token: expiry, one-use, actor/client/payload/state binding;
- sanitizer and injection fixtures for tickets, logs, skill files, and memory;
- mapping errors from application services to public MCP codes;
- deterministic run diagnosis.

### 13.2 Integration with PGlite

- OAuth schema and issuance/verification flow;
- all new tables with org isolation;
- transactionality of mutation + idempotency + audit;
- cross-tenant IDs always look like `NOT_FOUND`;
- CAS conflicts and retry after an ambiguous dependency response;
- retention and canary cleanup.

### 13.3 MCP contract

- initialize for `2025-11-25`, tools/list, and resources/list;
- snapshot canonical schemas and contract hash;
- POST content types, batch rejection per SDK/spec, 405 GET/DELETE;
- 401 challenge and both well-known discovery flows;
- the test client performs the OAuth PKCE and service client flow;
- every tool has annotations consistent with server policy.

### 13.4 Adapter/domain

- Jira create/update/comment/transition: expected state, rate limit, retry, and read-after-error;
- workflow branches/loops: valid graph, disallowed cycle, missing exit, max iterations;
- harness import SSRF, size, digest, and profile revision conflicts;
- memory secret rejection/redaction and content size;
- run trace pagination and result terminal/non-terminal.

### 13.5 End-to-end

Matrix: internal dogfood, destination preview, destination production, customer canary. For each:

1. discovery → OAuth → initialize;
2. read-only suite;
3. mutation-canary suite in isolated fixtures;
4. dispatch canary workflow → poll → trace → result → diagnose;
5. cleanup and audit assertion.

The release is blocked by any failure in auth, contract hash, org isolation, mutation cleanup, or terminal result.

## 14. Delivery phases

### Phase 1: internal deployment and dogfooding

1. Add the MCP foundation behind a feature flag to `apps/worker`.
2. Deploy the first vertical slice and OAuth on `ai-workflow-app`.
3. Read-only scopes first, then `runs:dispatch` for a selected group.
4. Run scheduled and manual dogfood Actions; audit all calls.
5. After at least 7 days without a cross-tenant/security failure, expand to ticket mutations, workflow authoring, harness, and memory in separate domain increments.

### Phase 2: GitHub Action in the Artur release pipeline

Source repo:

- CI generates `mcp-contract.json`, the hash, and runs unit/contract tests.
- `prepare-artur-release.yml` validates that release notes include MCP version/compatibility whenever the contract hash has changed.
- `sync-artur-release.yml` copies the implementation and the contract snapshot as part of the existing immutable snapshot; it does not deploy the client directly.

Destination repo:

- keep the existing `validate-artur-release.yml` and `publish-artur-release.yml` as the destination repo's ownership;
- add a reusable composite/Node Action `mcp-release-smoke`, invoked after obtaining the worker preview URL and again after the production deployment;
- the Action performs discovery, service OAuth, initialize, read-only smoke, and an optional mutation-canary;
- `release-manifest.json` gets an `mcp` section with the `/mcp` endpoint, server SemVer, protocol versions, contract hash, schema floor, smoke run ID, and result.

We do not introduce a secret name in the source repo. The Action implementation accepts named inputs; the concrete mapping to GitHub Environment secrets is defined and reviewed in the destination repo.

### Phase 3: publishing a versioned artifact

Because MCP is part of the worker, the artifact is not a local package to install in Claude/Codex. We publish an immutable `ai-workflow-mcp-manifest.json` as a GitHub Release asset and as part of the release manifest. It contains:

- MCP SemVer, source/destination commit SHA;
- protocol versions and the canonical endpoint path;
- contract snapshot/hash;
- DB/auth schema floor;
- supported AI Workflow/Artur release range;
- build provenance and smoke evidence.

The build fails if the generated contract differs from the committed snapshot without a SemVer change.

### Phase 4: rollout to customer deployments

1. Preflight inventory of every deployment: worker URL, Better Auth URL, organization slug, DB revision, Vercel project link, and the available secrets policy, without assuming shared names.
2. Expand migrations and deployment with `MCP_ENABLED=false`.
3. Create/rotate the smoke client in the given tenant; interactive clients remain consent-based.
4. Enable read-only for canary administrators, run smoke.
5. Enable dispatch and mutations per scope; memory delete last.
6. Every customer has a separate endpoint, audience, OAuth clients, DB, and audit retention.

### Phase 5: smoke, observability, rollback, and compatibility

- Publishing requires green preview and production smoke plus a matching contract hash.
- Alerts: error rate, auth failures, idempotency conflicts, cleanup failure, audit write failure, and run terminal timeout.
- An audit write failure for mutations is fail-closed; for read tools it can also be fail-closed on customer deployments, configurable by policy, fail-closed by default.
- App rollback uses the previous immutable Vercel deployment/commit SHA. `MCP_ENABLED=false` is an immediate kill switch.
- The DB rollout is expand/contract; new tables remain after an app rollback. Contract migrations/destructive cleanup happen only after the two-release compatibility window has passed.
- If the new MCP version fails smoke, the release does not tag the artifact and does not promote the customer deployment.

## 15. First vertical slice

### 15.1 Scope

`OAuth → tickets.get → tickets.list_runs → runs.get/runs.trace/runs.result/runs.diagnose → workflows.dispatch_preflight → workflows.dispatch → polling runs.get`

The slice deliberately excludes ticket mutation, workflow authoring, harness, and memory. It does, however, build the shared security/audit/idempotency foundation so that later domains do not create parallel mechanisms.

### 15.2 Planned files

**Dependencies/config/auth**

- Modify `apps/worker/package.json`: exactly matching versions of `@modelcontextprotocol/sdk` and `@better-auth/oauth-provider` with the lockfile; initially verified as `1.30.0` and `1.6.20`.
- Modify `pnpm-lock.yaml`: lock dependencies.
- Modify `apps/worker/env.ts` and `apps/worker/env.test.ts`: new MCP settings and safe defaults.
- Modify `apps/worker/src/auth.ts`, `auth.test.ts`, `auth-instance.ts`: OAuth Provider, scopes, consent route config, and service-client grant policy.
- Modify `apps/worker/src/db/auth-schema.ts` and its test: tables generated by the OAuth Provider at the same version.
- Create the next free Drizzle migration after the current journal state; the number is determined at implementation time, because the worktree already contains the user's uncommitted `0045_local_skill_source.sql` migration.

**MCP foundation**

- Create `apps/worker/src/mcp/contracts.ts`: envelope, public error codes, cursors, and common schemas.
- Create `apps/worker/src/mcp/request-context.ts`: token verification, audience, org membership, and actor context.
- Create `apps/worker/src/mcp/policy.ts`: tool/scope/role/mutation matrix.
- Create `apps/worker/src/mcp/audit-store.ts`: append-only writes and retention query.
- Create `apps/worker/src/mcp/idempotency-store.ts`: begin/complete/fail/replay.
- Create `apps/worker/src/mcp/sanitize-result.ts`: bounded/redacted envelope.
- Create `apps/worker/src/mcp/server.ts`: SDK server factory, version, and registry.
- Create `apps/worker/src/mcp/transport.ts`: H3 Streamable HTTP adapter, 401/405/content negotiation.
- Create `apps/worker/src/routes/mcp.post.ts`, `mcp.get.ts`, `mcp.delete.ts`.
- Create `apps/worker/src/routes/.well-known/oauth-protected-resource/mcp.get.ts` and the OAuth AS metadata forwarding routes required for the issuer path.

**Slice tools**

- Create `apps/worker/src/mcp/tools/tickets.ts`: `tickets.get`, `tickets.list_runs` via the issue tracker and run queries.
- Create `apps/worker/src/mcp/tools/runs.ts`: `runs.get`, `runs.trace`, `runs.result`, `runs.diagnose` via the existing run registry/observability/sanitizer.
- Create `apps/worker/src/mcp/tools/workflows.ts`: dispatch preflight and idempotent dispatch via `manual-dispatch/service.ts`.
- Create `apps/worker/src/mcp/run-diagnosis.ts`: deterministic rules and evidence refs.
- Create `apps/worker/src/mcp/tool-catalog.ts` and the committed `apps/worker/src/mcp/contracts/mcp-contract.json`.

**Dogfood/release**

- Create `apps/worker/scripts/mcp-smoke.ts`: real MCP client flow, not direct server imports.
- Create `.github/actions/mcp-release-smoke/action.yml` and `run.ts`/bundled artifact following the existing actions policy.
- Create `.github/workflows/mcp-dogfood.yml`: internal deployment smoke; all URL/credential values as inputs/environment mappings, without guessing secrets.
- Modify destination-owned release workflows only in the destination repo; the source plan documents the expected patch but does not fake a local file.

### 15.3 Slice tests

- `request-context.test.ts`: valid user, wrong audience, expired token, missing org, cross-deployment token, service client scopes.
- `policy.test.ts`: member read, admin dispatch, missing scope, service client least privilege.
- `audit-store.test.ts`: success/failure entries, redaction, org isolation, and retention boundary.
- `idempotency-store.test.ts`: replay, payload conflict, concurrent duplicate, ambiguous failure.
- `sanitize-result.test.ts`: injection strings remain data, secrets redacted, bounds, and cursor.
- `transport.test.ts`: initialize, tools/list, content types, 401 challenge, POST, 405 GET/DELETE, no session ID.
- `oauth-metadata.test.ts`: exact resource/audience, AS discovery, and PKCE S256 metadata.
- `tickets.test.ts`: ticket adapter result, untrusted marking, list runs tenant filter.
- `runs.test.ts`: nonterminal/terminal result, trace pagination, sanitized logs, cross-org not found.
- `run-diagnosis.test.ts`: dependency auth, sandbox timeout, validation failure, missing evidence, and unknown fallback.
- `workflows.test.ts`: preflight digest, deployed version conflict, idempotent duplicate dispatch, forbidden member.
- `mcp-contract.test.ts`: snapshot/hash and annotations vs policy.
- `mcp-smoke.test.ts`: fake OAuth/resource server negative paths; the live script runs on preview/internal.

### 15.4 Slice acceptance criteria

1. Claude Code and Codex can add `https://<internal-worker>/mcp`, complete OAuth PKCE, and see only the scopes consistent with consent/role.
2. The agent retrieves a real ticket, its runs, one run, a paginated trace, the result, and the diagnosis without the dashboard; no response or log contains seeded secrets.
3. An admin performs preflight and dispatch of an existing published workflow version. A retry with the same key returns the same run ID; a different payload with that key returns `IDEMPOTENCY_CONFLICT`.
4. A member can read, but dispatch gets `FORBIDDEN`; a missing scope gives `INSUFFICIENT_SCOPE`; an ID from another organization looks like `NOT_FOUND`.
5. The agent polls `runs.get` until terminal state and retrieves `runs.result`; a client timeout does not interrupt the workflow.
6. Every call creates a redacted audit event. An audit failure blocks dispatch.
7. `pnpm --filter worker test`, `typecheck`, the contract test, and the live internal smoke all pass; the committed contract hash matches `/mcp` and the manifest.
8. `MCP_ENABLED=false` returns a controlled `404/disabled` without affecting `/api/v1`, webhooks, cron, or the dashboard.
9. The internal deployment remains stateless; two consecutive poll calls may hit different instances and return consistent state.
10. The release Action can perform discovery → service token → initialize → slice smoke and return JSON evidence ready to attach to the release manifest.

## 16. Expansion order after the slice

Every increment has its own TDD/review gate, but uses the same foundation:

1. ticket create/update/comment/labels/transition;
2. workflow create/draft/validate/publish/rollback, along with branch/loop scenario tests;
3. harness profiles, skill discovery/import/refresh, and assignments;
4. memory list/get/update/delete;
5. dogfood suite registry, async results, and cleanup;
6. customer rollout automation and compatibility enforcement.

## 17. Decisions excluded from scope

- No separate MCP deployment and no local npm package installed in Claude/Codex.
- No dependency on the dashboard and no new UI screens.
- No legacy HTTP+SSE.
- No token passthrough.
- No generative diagnosis on the MCP side in the first version.
- No shared database or shared OAuth client across customers.
- No support for `ai-workflow-demo`.

## 18. Risks and deliberate trade-offs

- A shared worker simplifies security and reuse, but increases the shared blast radius; a feature flag, rate limit, timeout, and per-tool circuit breaker are conditions for rollout.
- Full org isolation for some existing stores may require domain migrations; MCP cannot mask this with a check at the entry point alone.
- DCR improves UX for agent clients, but increases the abuse/SSRF surface; customer deployments start from pre-registration, and enable DCR explicitly.
- Polling is less efficient than an event stream, but it is simpler, deterministic, and consistent with stateless Vercel. Streaming can be added additively after measurements.
- Preview/confirm adds a second round trip, but it is required for changes that affect an external system, code execution, or future agent context.

## 19. Settled assumptions

- Dogfooding happens on the internal `ai-workflow-app`, not on demo.
- The public endpoint of every dedicated worker is `/mcp`.
- An interactive agent acts on behalf of the user; the service client is only for smoke/dogfood automation.
- Audit retention is 365 days by default and does not include full payloads.
- The stable starting protocol is MCP `2025-11-25`, using Streamable HTTP only.
- The first vertical slice ends with a real dispatch and a terminal run result.
