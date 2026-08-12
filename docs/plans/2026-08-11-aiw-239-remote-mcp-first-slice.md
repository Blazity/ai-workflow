# AI Workflow Remote MCP First Vertical Slice Implementation Plan

**Goal:** Dostarczyć na wewnętrznym workerze stateless Remote MCP pod `/mcp`, które przez OAuth pozwala agentowi odczytać ticket i jego runy, pobrać status/trace/wynik/diagnozę oraz idempotentnie uruchomić opublikowany workflow i pollować go do końca.

**Architecture:** MCP jest osadzone w `apps/worker` jako cienki transport nad istniejącymi adapterami, run queries, run observability i manual-dispatch service. Better Auth wydaje tokeny OAuth 2.1 związane z audience workera; wspólna warstwa request context, policy, audit, idempotency i sanitization działa przed każdym tool handlerem. Transport jest stateless Streamable HTTP dla MCP `2025-11-25` i tworzy świeży server/transport per POST.

**Tech Stack:** TypeScript 5.8, Nitro/H3, Better Auth `1.6.20`, `@better-auth/oauth-provider@1.6.20`, `@modelcontextprotocol/sdk@1.30.0`, Zod 3, Drizzle/Postgres/PGlite, Vitest 3, pnpm, Vercel, GitHub Actions.

## Global Constraints

- Nie implementować osobnego `apps/mcp`; publiczny endpoint to `/mcp` istniejącego dedykowanego workera.
- Obsługiwać wyłącznie stabilny MCP `2025-11-25` przez Streamable HTTP; nie dodawać legacy HTTP+SSE ani sesji `Mcp-Session-Id`.
- Interaktywny agent używa Authorization Code + PKCE S256 i dziedziczy organizację/rolę użytkownika; `client_credentials` służy wyłącznie smoke automation.
- Canonical OAuth resource i token audience to `canonicalMcpResource(env.BETTER_AUTH_URL)`, czyli publiczny origin workera z dokładną ścieżką `/mcp`; token passthrough do adapterów jest zabroniony.
- Narzędzia nie przyjmują `organizationId`; tenant pochodzi wyłącznie ze zweryfikowanego tokenu i membership w organizacji deploymentu.
- Każda mutacja wymaga `idempotencyKey`; dispatch dodatkowo wymaga udanego preflight digest i `expectedDeployedVersion`.
- Audit retention ma domyślnie 365 dni i nie zapisuje tokenów, sekretów, pełnych ticketów, logów ani memory.
- Treści ticketów, komentarzy, logów i trace są `external_untrusted`, redagowane i limitowane przed odpowiedzią.
- `MCP_ENABLED=false` jest domyślnym kill switchem poza wewnętrznym dogfood deploymentem.
- `ai-workflow-demo` pozostaje całkowicie poza zakresem.
- Zachować wszystkie istniejące zmiany użytkownika. W szczególności nie modyfikować ani nie usuwać niezatwierdzonej migracji `0045_local_skill_source.sql`.
- Specyfikacja źródłowa: `docs/plans/2026-08-11-aiw-239-remote-mcp-design.md`.

## File map

### Foundation owned by the slice

- `apps/worker/src/mcp/contracts.ts` — publiczne schemas, envelope, errors i tool-name union.
- `apps/worker/src/mcp/oauth.ts` — OAuth Provider config/resource verification helpers.
- `apps/worker/src/mcp/request-context.ts` — token → actor/client/org/scopes.
- `apps/worker/src/mcp/policy.ts` — stała macierz role + scopes + mutation class.
- `apps/worker/src/mcp/audit-store.ts` — append-only audit API.
- `apps/worker/src/mcp/idempotency-store.ts` — begin/complete/fail/replay API.
- `apps/worker/src/mcp/rate-limit-store.ts` — atomowe per-tenant/actor/client/tool windows.
- `apps/worker/src/mcp/sanitize-result.ts` — redaction, trust labels i byte bounds.
- `apps/worker/src/mcp/server.ts` — świeży `McpServer` i tool/resource registration.
- `apps/worker/src/mcp/transport.ts` — H3/Node Streamable HTTP bridge.
- `apps/worker/src/mcp/tool-catalog.ts` — canonical public catalog i contract hash.
- `apps/worker/src/mcp/contracts/mcp-contract.json` — committed generated snapshot.

### Slice domain files

- `apps/worker/src/mcp/tools/tickets.ts` — `tickets.get`, `tickets.list_runs`.
- `apps/worker/src/mcp/tools/runs.ts` — `runs.get`, `runs.trace`, `runs.result`, `runs.diagnose`.
- `apps/worker/src/mcp/tools/workflows.ts` — preflight i dispatch.
- `apps/worker/src/mcp/run-diagnosis.ts` — deterministyczne klasyfikacje.

### HTTP, scripts and automation

- `apps/worker/src/routes/mcp.post.ts`, `mcp.get.ts`, `mcp.delete.ts` — publiczny transport.
- `apps/worker/src/routes/.well-known/oauth-protected-resource/mcp.get.ts` — RFC 9728 metadata.
- `apps/worker/src/routes/.well-known/oauth-authorization-server/api/auth.get.ts` — issuer-path discovery forwarding.
- `apps/worker/src/routes/api/v1/system/mcp-readiness.get.ts` — deployment readiness.
- `apps/worker/scripts/generate-mcp-contract.ts` — deterministic contract artifact.
- `apps/worker/scripts/mcp-smoke.ts` — real HTTP MCP smoke client.
- `.github/actions/mcp-release-smoke/action.yml` — cienki composite Action nad skryptem.
- `.github/workflows/mcp-dogfood.yml` — internal post-deploy/manual dogfood.

### Persistence and existing integration points

- `apps/worker/src/db/auth-schema.ts` — OAuth Provider tables.
- `apps/worker/src/db/schema.ts` — audit i idempotency tables.
- `apps/worker/drizzle/0044_mcp_foundation.sql` and matching Drizzle metadata — wolny numer z committed baseline, celowo przed user-owned, niezatwierdzonym `0045`.
- Existing services remain authoritative: `src/adapters/issue-tracker/types.ts`, `src/db/queries/runs-read.ts`, `src/db/queries/run-detail-read.ts`, `src/run-observability/store.ts`, `src/manual-dispatch/service.ts`.

---

### Task 1: Pin dependencies and validate MCP configuration

**Files:**

- Modify: `apps/worker/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/worker/env.ts`
- Modify: `apps/worker/env.test.ts`

**Interfaces:**

- Produces `env.MCP_ENABLED: boolean`, `env.MCP_SERVER_VERSION: string`, `env.MCP_ALLOW_PUBLIC_DCR: boolean`, `env.MCP_AUDIT_RETENTION_DAYS: number`, `env.MCP_MAX_REQUEST_BYTES: number`, `env.MCP_MAX_RESULT_BYTES: number`, `env.MCP_TOOL_TIMEOUT_MS: number`, `env.MCP_READ_RATE_LIMIT_PER_MINUTE: number`, `env.MCP_MUTATION_RATE_LIMIT_PER_MINUTE: number`, `env.MCP_DOGFOOD_FIXTURE_PREFIX: string`.
- Does not add a client secret env var; smoke credentials enter only through GitHub Action inputs at runtime.

- [ ] **Step 1: Add failing env tests**

Add cases proving defaults and invalid bounds:

```ts
expect(env.MCP_ENABLED).toBe(false);
expect(env.MCP_SERVER_VERSION).toBe("0.1.0");
expect(env.MCP_ALLOW_PUBLIC_DCR).toBe(false);
expect(env.MCP_AUDIT_RETENTION_DAYS).toBe(365);
expect(env.MCP_MAX_REQUEST_BYTES).toBe(1_048_576);
expect(env.MCP_MAX_RESULT_BYTES).toBe(524_288);
expect(env.MCP_TOOL_TIMEOUT_MS).toBe(30_000);
expect(env.MCP_READ_RATE_LIMIT_PER_MINUTE).toBe(120);
expect(env.MCP_MUTATION_RATE_LIMIT_PER_MINUTE).toBe(20);
expect(env.MCP_DOGFOOD_FIXTURE_PREFIX).toBe("mcp-dogfood");
```

Add table-driven failures for `MCP_AUDIT_RETENTION_DAYS=0`, `MCP_TOOL_TIMEOUT_MS=999`, zero/negative rate limits, non-SemVer `MCP_SERVER_VERSION`, and `MCP_MAX_RESULT_BYTES > MCP_MAX_REQUEST_BYTES`.

- [ ] **Step 2: Run the tests and verify failure**

Run: `pnpm --filter worker exec vitest run env.test.ts`

Expected: FAIL because the MCP keys do not exist in the env schema.

- [ ] **Step 3: Add exact dependencies and env schemas**

Add runtime dependencies:

```json
"@better-auth/oauth-provider": "1.6.20",
"@modelcontextprotocol/sdk": "1.30.0"
```

Add Zod fields with the defaults above. Use `z.coerce.boolean()` only if existing env boolean parsing proves it handles the string `"false"` correctly; otherwise use the repository’s explicit boolean transform. Add a cross-field refinement enforcing result bytes `<=` request bytes.

- [ ] **Step 4: Install and run focused verification**

Run: `pnpm install --lockfile-only && pnpm --filter worker exec vitest run env.test.ts && pnpm --filter worker typecheck`

Expected: env tests PASS; typecheck PASS; lockfile contains exactly the pinned SDK/provider versions.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/package.json apps/worker/env.ts apps/worker/env.test.ts pnpm-lock.yaml
git commit -m "chore(worker): add MCP runtime configuration"
```

### Task 2: Add OAuth, audit and idempotency persistence

**Files:**

- Modify: `apps/worker/src/db/auth-schema.ts`
- Modify: `apps/worker/src/db/auth-schema.test.ts`
- Modify: `apps/worker/src/db/schema.ts`
- Create: `apps/worker/src/db/mcp-foundation-migration.test.ts`
- Create: `apps/worker/drizzle/0044_mcp_foundation.sql`
- Create: `apps/worker/drizzle/meta/0044_snapshot.json`
- Modify: `apps/worker/drizzle/meta/_journal.json`

**Interfaces:**

- Produces Drizzle exports `oauthClient`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`, `mcpIdempotencyKeys`, `mcpAuditEvents`, `mcpRateLimitWindows`.
- `mcpIdempotencyKeys` unique key: `(organizationId, actorSubject, clientId, toolName, idempotencyKey)`.
- `mcpAuditEvents` is append-only at application level and indexed by `(organizationId, occurredAt)` and `requestId`.
- `mcpRateLimitWindows` has primary key `(organizationId, actorSubject, clientId, toolName, windowStartedAt)` and expires after two full windows.

- [ ] **Step 1: Add failing schema-shape tests**

Assert Better Auth camelCase property keys and snake_case columns, plus MCP constraints:

```ts
expect(getTableName(oauthClient)).toBe("oauth_client");
expect(getTableName(oauthRefreshToken)).toBe("oauth_refresh_token");
expect(getTableName(oauthAccessToken)).toBe("oauth_access_token");
expect(getTableName(oauthConsent)).toBe("oauth_consent");
expect(getTableName(mcpIdempotencyKeys)).toBe("mcp_idempotency_keys");
expect(getTableName(mcpAuditEvents)).toBe("mcp_audit_events");
expect(getTableName(mcpRateLimitWindows)).toBe("mcp_rate_limit_windows");
```

The test must also assert foreign keys to `organization`, OAuth client/user/session references, `expires_at` indexes, and the idempotency state check `started|completed|failed`.

- [ ] **Step 2: Run schema tests and verify failure**

Run: `pnpm --filter worker exec vitest run src/db/auth-schema.test.ts src/db/mcp-foundation-migration.test.ts`

Expected: FAIL on missing table exports and migration file.

- [ ] **Step 3: Add exact table shapes**

Use Better Auth’s generated Drizzle schema for provider version `1.6.20` as the source of truth, then map the generated `oauthClient`, `oauthRefreshToken`, `oauthAccessToken` and `oauthConsent` exports to SQL tables `oauth_client`, `oauth_refresh_token`, `oauth_access_token` and `oauth_consent`. Preserve every generated camelCase property key, type, default, index and foreign key; the checked-in schema test compares the exported Drizzle config with a generator fixture captured from exactly `@better-auth/oauth-provider@1.6.20`.

Add application tables with these public row semantics:

```ts
type McpIdempotencyState = "started" | "completed" | "failed";
type McpIdempotencyRow = {
  organizationId: string;
  actorSubject: string;
  clientId: string;
  toolName: string;
  idempotencyKey: string;
  payloadHash: string;
  state: McpIdempotencyState;
  safeResponse: unknown | null;
  errorCode: string | null;
  expiresAt: Date;
};

type McpAuditEventRow = {
  id: string;
  requestId: string;
  traceId: string;
  organizationId: string;
  actorSubject: string;
  clientId: string;
  role: "owner" | "admin" | "member" | "service";
  scopes: string[];
  toolName: string;
  mutationClass: "read" | "direct" | "confirmed";
  targetRefs: string[];
  inputHash: string;
  outputHash: string | null;
  idempotencyKeyHash: string | null;
  outcome: "attempted" | "success" | "rejected" | "failed";
  errorCode: string | null;
  latencyMs: number;
  serverVersion: string;
  contractHash: string;
  occurredAt: Date;
};

type McpRateLimitWindowRow = {
  organizationId: string;
  actorSubject: string;
  clientId: string;
  toolName: string;
  windowStartedAt: Date;
  requestCount: number;
  expiresAt: Date;
};
```

- [ ] **Step 4: Generate and inspect the migration**

Run: `pnpm --filter worker db:generate`

Expected: migration number `0044`, snapshot `0044_snapshot.json`, and journal entry after committed `0043`. Rename only the generated SQL basename to `0044_mcp_foundation.sql` if Drizzle generated another suffix; update journal consistently. Inspect SQL and verify it contains only OAuth/MCP additions and no drop/rename of existing user tables. When the branch is later combined with the user-owned `0045`, keep journal order `0044`, then `0045`.

- [ ] **Step 5: Run migration tests**

Run: `pnpm --filter worker exec vitest run src/db/auth-schema.test.ts src/db/mcp-foundation-migration.test.ts && pnpm --filter worker typecheck`

Expected: PASS; applying migrations twice through the repository migration harness is harmless; PGlite can insert two tenants with the same idempotency key but rejects a duplicate in one tenant/actor/client/tool namespace.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/db/auth-schema.ts apps/worker/src/db/auth-schema.test.ts apps/worker/src/db/schema.ts apps/worker/src/db/mcp-foundation-migration.test.ts apps/worker/drizzle/0044_mcp_foundation.sql apps/worker/drizzle/meta/0044_snapshot.json apps/worker/drizzle/meta/_journal.json
git commit -m "feat(worker): add MCP OAuth and audit persistence"
```

### Task 3: Configure OAuth Provider and build authenticated actor context

**Files:**

- Create: `apps/worker/src/mcp/oauth.ts`
- Create: `apps/worker/src/mcp/oauth.test.ts`
- Create: `apps/worker/src/mcp/contracts.ts`
- Create: `apps/worker/src/mcp/contracts.test.ts`
- Create: `apps/worker/src/mcp/request-context.ts`
- Create: `apps/worker/src/mcp/request-context.test.ts`
- Modify: `apps/worker/src/auth.ts`
- Modify: `apps/worker/src/auth.test.ts`
- Modify: `apps/worker/src/auth-instance.ts`
- Modify: `apps/worker/src/routes/api/auth/[...all].ts`
- Create: `apps/worker/src/mcp/auth-pages.ts`
- Create: `apps/worker/src/mcp/auth-pages.test.ts`
- Create: `apps/worker/src/routes/mcp-auth/login.get.ts`
- Create: `apps/worker/src/routes/mcp-auth/login.post.ts`
- Create: `apps/worker/src/routes/mcp-auth/consent.get.ts`
- Create: `apps/worker/src/routes/mcp-auth/consent.post.ts`
- Modify: `apps/worker/src/routes/api/dashboard-auth/sso/start.get.ts`
- Modify: `apps/worker/src/routes/api/dashboard-auth/sso/start.get.test.ts`
- Modify: `apps/worker/src/routes/api/dashboard-auth/sso/complete.get.ts`
- Modify: `apps/worker/src/routes/api/dashboard-auth/sso/complete.get.test.ts`

**Interfaces:**

```ts
export const MCP_SCOPES = ["mcp:read", "runs:dispatch"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export type McpErrorCode =
  | "UNAUTHENTICATED"
  | "INSUFFICIENT_SCOPE"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "RATE_LIMITED"
  | "DEPENDENCY_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class McpPublicError extends Error {
  constructor(
    readonly code: McpErrorCode,
    safeMessage: string,
    readonly retryable: boolean,
  );
}

export type McpActorContext = {
  kind: "user" | "service";
  subject: string;
  userId: string | null;
  clientId: string;
  organizationId: string;
  organizationSlug: string;
  role: "owner" | "admin" | "member" | "service";
  scopes: ReadonlySet<McpScope>;
  audience: string;
};

export function canonicalMcpResource(baseUrl: string): string;
export async function requireMcpActor(request: Request): Promise<McpActorContext>;
export function safeOAuthReturnPath(value: unknown): string | null;
```

- [ ] **Step 1: Write failing OAuth option tests**

Cover:

```ts
expect(canonicalMcpResource("https://worker.example.com/")).toBe(
  "https://worker.example.com/mcp",
);
expect(providerMetadata.code_challenge_methods_supported).toContain("S256");
expect(providerMetadata.grant_types_supported).toEqual(
  expect.arrayContaining(["authorization_code", "client_credentials", "refresh_token"]),
);
```

Assert unauthenticated DCR follows `MCP_ALLOW_PUBLIC_DCR` and defaults false; when enabled it accepts only public clients with `token_endpoint_auth_method=none`, PKCE S256 and safe HTTPS/loopback redirect URIs. Assert `clientReference` equals active organization and client credentials without a fixed organization/reference are rejected. Add contract tests asserting the two scope names are unique, lowercase and accepted by the provider config, and that `McpPublicError` exposes only code, safe message and retryability.

Add auth-page tests for HTML escaping, exact client display metadata, allowlisted scope rendering, missing/expired `consent_code`, CSRF-safe POST, and `safeOAuthReturnPath()`. The only accepted resume paths start with `/api/auth/oauth2/authorize?`; absolute URLs, protocol-relative URLs, encoded path traversal and any other worker path return `null`.

- [ ] **Step 2: Write failing request-context tests**

Use mocked `verifyAccessToken` and PGlite memberships for: valid member, valid admin, wrong audience, expired token, missing scope, subject not in deployment organization, token org different from `DASHBOARD_ORG_SLUG`, and service client with fixed org/scopes.

- [ ] **Step 3: Run and verify failure**

Run: `pnpm --filter worker exec vitest run src/mcp/contracts.test.ts src/mcp/oauth.test.ts src/mcp/auth-pages.test.ts src/mcp/request-context.test.ts src/auth.test.ts`

Expected: FAIL because OAuth Provider and MCP request context are absent.

- [ ] **Step 4: Mount OAuth Provider conservatively**

Configure `oauthProvider()` in `createAuth()` with:

- login page and consent page under the existing dashboard origin;
- PKCE S256 required for public clients;
- `allowDynamicClientRegistration: true` and `allowUnauthenticatedClientRegistration: env.MCP_ALLOW_PUBLIC_DCR`;
- exact allowed MCP scopes from `contracts.ts`;
- `clientReference` bound to `session.activeOrganizationId`;
- custom access-token claims containing organization reference and role, never secrets;
- `client_credentials` accepted only when the OAuth client record has the deployment organization reference and allowlisted scopes.

Set `loginPage` to `${BETTER_AUTH_URL}/mcp-auth/login` and `consentPage` to `${BETTER_AUTH_URL}/mcp-auth/consent`. The worker-owned login route supports the existing email/password path and a link to the existing SSO start route; the consent route shows client name, exact redirect hostname and requested scopes, then calls `auth.api.oauth2Consent({ body: { accept, scope, consent_code }, headers })`. It never renders client-supplied HTML.

Extend the existing SSO start/complete routes with an optional, strictly validated `returnTo`. When present it is copied into the same-origin callback URL and completion redirects back to the OAuth authorize request after Better Auth has established the worker-domain session. When absent the current dashboard handoff behavior remains byte-for-byte compatible.

Ensure the existing `/api/auth/**` catch-all and issuer-path well-known requests both reach `auth.handler`.

- [ ] **Step 5: Implement resource verification**

`requireMcpActor()` must:

1. parse exactly one Bearer token;
2. call the provider resource client’s `verifyAccessToken(token, { verifyOptions: { issuer, audience } })`;
3. require `aud === canonicalMcpResource(env.BETTER_AUTH_URL)`;
4. load the organization by `DASHBOARD_ORG_SLUG` and verify token reference/membership;
5. normalize the role through `normalizeDashboardRole()` for users;
6. intersect issued scopes with scopes allowed for that client;
7. throw typed `McpPublicError` without token or claim detail.

- [ ] **Step 6: Run auth verification**

Run: `pnpm --filter worker exec vitest run src/mcp/contracts.test.ts src/mcp/oauth.test.ts src/mcp/auth-pages.test.ts src/mcp/request-context.test.ts src/auth.test.ts src/routes/api/auth/auth-route.test.ts src/routes/api/dashboard-auth/sso/start.get.test.ts src/routes/api/dashboard-auth/sso/complete.get.test.ts && pnpm --filter worker typecheck`

Expected: PASS; all pre-existing login/SSO/session tests remain green.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/mcp/oauth.ts apps/worker/src/mcp/oauth.test.ts apps/worker/src/mcp/contracts.ts apps/worker/src/mcp/contracts.test.ts apps/worker/src/mcp/auth-pages.ts apps/worker/src/mcp/auth-pages.test.ts apps/worker/src/mcp/request-context.ts apps/worker/src/mcp/request-context.test.ts apps/worker/src/auth.ts apps/worker/src/auth.test.ts apps/worker/src/auth-instance.ts 'apps/worker/src/routes/api/auth/[...all].ts' apps/worker/src/routes/mcp-auth/login.get.ts apps/worker/src/routes/mcp-auth/login.post.ts apps/worker/src/routes/mcp-auth/consent.get.ts apps/worker/src/routes/mcp-auth/consent.post.ts apps/worker/src/routes/api/dashboard-auth/sso/start.get.ts apps/worker/src/routes/api/dashboard-auth/sso/start.get.test.ts apps/worker/src/routes/api/dashboard-auth/sso/complete.get.ts apps/worker/src/routes/api/dashboard-auth/sso/complete.get.test.ts
git commit -m "feat(worker): authorize MCP clients with OAuth"
```

### Task 4: Implement contracts, policy, sanitization, audit and idempotency

**Files:**

- Modify: `apps/worker/src/mcp/contracts.ts`
- Modify: `apps/worker/src/mcp/contracts.test.ts`
- Create: `apps/worker/src/mcp/policy.ts`
- Create: `apps/worker/src/mcp/policy.test.ts`
- Create: `apps/worker/src/mcp/sanitize-result.ts`
- Create: `apps/worker/src/mcp/sanitize-result.test.ts`
- Create: `apps/worker/src/mcp/audit-store.ts`
- Create: `apps/worker/src/mcp/audit-store.test.ts`
- Create: `apps/worker/src/mcp/idempotency-store.ts`
- Create: `apps/worker/src/mcp/idempotency-store.test.ts`
- Create: `apps/worker/src/mcp/rate-limit-store.ts`
- Create: `apps/worker/src/mcp/rate-limit-store.test.ts`
- Create: `apps/worker/src/mcp/execute-tool.ts`
- Create: `apps/worker/src/mcp/execute-tool.test.ts`

**Interfaces:**

```ts
export const FIRST_SLICE_TOOLS = [
  "system.capabilities",
  "tickets.get",
  "tickets.list_runs",
  "runs.get",
  "runs.trace",
  "runs.result",
  "runs.diagnose",
  "workflows.dispatch_preflight",
  "workflows.dispatch",
] as const;
export type McpToolName = (typeof FIRST_SLICE_TOOLS)[number];

export type McpEnvelope<T> = {
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

export type SanitizeOptions = {
  requestId: string;
  traceId: string;
  trust: McpEnvelope<unknown>["meta"]["trust"];
  maxBytes: number;
  nextCursor?: string;
  secrets?: readonly string[];
};

export type IdempotencyInput = {
  organizationId: string;
  actorSubject: string;
  clientId: string;
  toolName: McpToolName;
  idempotencyKey: string;
  payloadHash: string;
  now: Date;
  expiresAt: Date;
};

export type McpAuditInput = {
  requestId: string;
  traceId: string;
  actor: McpActorContext;
  toolName: McpToolName;
  mutationClass: "read" | "direct" | "confirmed";
  targetRefs: string[];
  inputHash: string;
  outputHash: string | null;
  idempotencyKeyHash: string | null;
  outcome: "attempted" | "success" | "rejected" | "failed";
  errorCode: McpErrorCode | null;
  latencyMs: number;
  occurredAt: Date;
};

export type McpToolDependencies = {
  db: Db;
  adapters: Adapters;
  actor: McpActorContext;
  requestId: string;
  traceId: string;
  now: () => Date;
};

export function authorizeTool(actor: McpActorContext, tool: McpToolName): void;
export function sanitizeMcpData<T>(data: T, options: SanitizeOptions): McpEnvelope<T>;
export async function writeMcpAudit(db: Db, event: McpAuditInput): Promise<void>;
export async function beginMcpMutation<T>(db: Db, input: IdempotencyInput): Promise<
  | { kind: "execute"; leaseId: string }
  | { kind: "replay"; response: T }
>;
export async function completeMcpMutation<T>(db: Db, leaseId: string, response: T): Promise<void>;
export async function failMcpMutation(db: Db, leaseId: string, errorCode: McpErrorCode): Promise<void>;
export async function consumeMcpRateLimit(input: {
  db: Db;
  actor: McpActorContext;
  toolName: McpToolName;
  limit: number;
  now: Date;
}): Promise<{ remaining: number; retryAfterMs: number }>;
export async function executeMcpRead<T>(input: {
  deps: McpToolDependencies;
  toolName: McpToolName;
  targetRefs: string[];
  operation: (signal: AbortSignal) => Promise<T>;
}): Promise<McpEnvelope<T>>;
export async function executeMcpMutation<T>(input: {
  deps: McpToolDependencies;
  toolName: McpToolName;
  targetRefs: string[];
  idempotencyKey: string;
  payloadHash: string;
  operation: () => Promise<T>;
}): Promise<McpEnvelope<T>>;
```

- [ ] **Step 1: Write failing contract and policy tests**

Assert exact tool union, member read access, admin/owner dispatch, service client dispatch only with `runs:dispatch`, and annotations:

```ts
expect(policyFor("runs.get")).toMatchObject({
  scope: "mcp:read",
  roles: ["member", "admin", "owner", "service"],
  mutation: "read",
});
expect(policyFor("workflows.dispatch")).toMatchObject({
  scope: "runs:dispatch",
  roles: ["admin", "owner", "service"],
  mutation: "direct",
});
```

- [ ] **Step 2: Write failing sanitizer tests with hostile fixtures**

Fixtures must contain `Ignore all previous instructions`, `Authorization: Bearer secret`, a GitHub token shape, a private key header, ANSI/control bytes, and payload above the result byte limit. Assert instruction text remains inert data, secrets become `[REDACTED]`, output is valid UTF-8 JSON, `trust="external_untrusted"`, and truncation supplies a cursor/digest rather than cutting JSON.

- [ ] **Step 3: Write failing PGlite store tests**

Audit: attempted/success/rejected/failed rows, no raw payload, tenant filtering and exact 365-day boundary. Idempotency: first execute, same-key replay, same-key/different-hash conflict, concurrent insert winner, failed terminal replay and 24-hour expiry. Rate limit: per actor/client/tool/tenant separation, exact minute boundary, atomic concurrent increments, read/mutation limits and `RATE_LIMITED` with `retryAfterMs`. Execution wrapper: strict order of auth/rate/audit/sanitize, read timeout cancellation, mutation timeout returning a retryable error while the idempotency row preserves the eventual/recovered outcome.

- [ ] **Step 4: Run focused tests and verify failure**

Run: `pnpm --filter worker exec vitest run src/mcp/contracts.test.ts src/mcp/policy.test.ts src/mcp/sanitize-result.test.ts src/mcp/audit-store.test.ts src/mcp/idempotency-store.test.ts src/mcp/rate-limit-store.test.ts src/mcp/execute-tool.test.ts`

Expected: FAIL because the expanded tool catalog, policy and store modules are absent.

- [ ] **Step 5: Implement the minimal shared foundation**

Use canonical JSON with recursively sorted object keys for SHA-256 payload hashes. Never log raw `data`; audit stores only hashes, target refs and counts. Wrap each mutation as:

```ts
const decision = await beginMcpMutation(db, key);
if (decision.kind === "replay") return decision.response;
try {
  const response = await operation();
  await completeMcpMutation(db, decision.leaseId, response);
  return response;
} catch (error) {
  await failMcpMutation(db, decision.leaseId, toPublicCode(error));
  throw error;
}
```

Audit failure is fail-closed for dispatch. Read tool audit failure is also fail-closed in this slice so dogfood exercises the strict customer default. Consume the database-backed per-tool rate limit after authorization and before reading domain data or beginning idempotency; use the read or mutation limit selected from policy. Put this ordering in `execute-tool.ts`, not in every domain handler. Read operations receive `AbortSignal.timeout(MCP_TOOL_TIMEOUT_MS)`. A mutation timeout never changes the idempotency key and returns a retryable public error instructing the caller to retry that same key; the existing manual-dispatch recovery plus MCP idempotency decides the final outcome.

- [ ] **Step 6: Run foundation tests**

Run: `pnpm --filter worker exec vitest run src/mcp/contracts.test.ts src/mcp/policy.test.ts src/mcp/sanitize-result.test.ts src/mcp/audit-store.test.ts src/mcp/idempotency-store.test.ts src/mcp/rate-limit-store.test.ts src/mcp/execute-tool.test.ts && pnpm --filter worker typecheck`

Expected: PASS with no secret values in Vitest output or snapshots.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/mcp/contracts.ts apps/worker/src/mcp/contracts.test.ts apps/worker/src/mcp/policy.ts apps/worker/src/mcp/policy.test.ts apps/worker/src/mcp/sanitize-result.ts apps/worker/src/mcp/sanitize-result.test.ts apps/worker/src/mcp/audit-store.ts apps/worker/src/mcp/audit-store.test.ts apps/worker/src/mcp/idempotency-store.ts apps/worker/src/mcp/idempotency-store.test.ts apps/worker/src/mcp/rate-limit-store.ts apps/worker/src/mcp/rate-limit-store.test.ts apps/worker/src/mcp/execute-tool.ts apps/worker/src/mcp/execute-tool.test.ts
git commit -m "feat(worker): add MCP safety foundation"
```

### Task 5: Serve stateless MCP and OAuth discovery

**Files:**

- Create: `apps/worker/src/mcp/server.ts`
- Create: `apps/worker/src/mcp/server.test.ts`
- Create: `apps/worker/src/mcp/transport.ts`
- Create: `apps/worker/src/mcp/transport.test.ts`
- Create: `apps/worker/src/routes/mcp.post.ts`
- Create: `apps/worker/src/routes/mcp.get.ts`
- Create: `apps/worker/src/routes/mcp.delete.ts`
- Create: `apps/worker/src/routes/.well-known/oauth-protected-resource/mcp.get.ts`
- Create: `apps/worker/src/routes/.well-known/oauth-authorization-server/api/auth.get.ts`
- Create: `apps/worker/src/mcp/oauth-metadata.test.ts`

**Interfaces:**

```ts
export function createMcpServer(deps: McpToolDependencies): McpServer;
export async function handleMcpPost(event: H3Event): Promise<void>;
export function protectedResourceMetadata(): {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
};
```

- [ ] **Step 1: Write failing transport tests**

Test a real JSON-RPC initialize request with protocol `2025-11-25`, `tools/list`, invalid content type, body over limit, missing bearer, wrong audience, `GET`, `DELETE`, and disabled flag. Assert:

```ts
expect(response.headers.get("mcp-session-id")).toBeNull();
expect(response.status).toBe(200);
expect(initialize.result.serverInfo.version).toBe("0.1.0");
expect(getResponse.status).toBe(405);
expect(deleteResponse.status).toBe(405);
```

- [ ] **Step 2: Write failing metadata tests**

Assert `resource === https://worker.example.com/mcp`, authorization server is `BETTER_AUTH_URL`, scopes are minimal, and an unauthenticated `/mcp` response contains:

```text
WWW-Authenticate: Bearer resource_metadata="https://worker.example.com/.well-known/oauth-protected-resource/mcp", scope="mcp:read"
```

Also assert the issuer-path RFC 8414 request reaches Better Auth and advertises S256.

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm --filter worker exec vitest run src/mcp/server.test.ts src/mcp/transport.test.ts src/mcp/oauth-metadata.test.ts`

Expected: FAIL because the route and server do not exist.

- [ ] **Step 4: Implement one-request server lifecycle**

For every authenticated POST:

```ts
const server = createMcpServer(deps);
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
});
await server.connect(transport);
await transport.handleRequest(event.node.req, event.node.res, body);
await server.close();
```

Reject batch requests and all protocol versions except `2025-11-25`. Do not retain server or transport in module-global state. Register `system.capabilities` immediately; domain tools are added in later tasks.

- [ ] **Step 5: Implement discovery and method routes**

Use Better Auth’s resource metadata helper where it produces the exact RFC 9728 document; wrap only to force canonical `/mcp` resource and scopes. Route GET/DELETE with `Allow: POST` and `405`. With `MCP_ENABLED=false`, return `404` before OAuth work.

- [ ] **Step 6: Run transport and regression tests**

Run: `pnpm --filter worker exec vitest run src/mcp/server.test.ts src/mcp/transport.test.ts src/mcp/oauth-metadata.test.ts src/routes/api/auth/auth-route.test.ts src/middleware/api-auth.test.ts && pnpm --filter worker typecheck`

Expected: PASS; `/api/v1`, `/api/auth`, webhooks and cron middleware behavior is unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/mcp/server.ts apps/worker/src/mcp/server.test.ts apps/worker/src/mcp/transport.ts apps/worker/src/mcp/transport.test.ts apps/worker/src/mcp/oauth-metadata.test.ts apps/worker/src/routes/mcp.post.ts apps/worker/src/routes/mcp.get.ts apps/worker/src/routes/mcp.delete.ts apps/worker/src/routes/.well-known/oauth-protected-resource/mcp.get.ts apps/worker/src/routes/.well-known/oauth-authorization-server/api/auth.get.ts
git commit -m "feat(worker): serve stateless remote MCP"
```

### Task 6: Add ticket read tools

**Files:**

- Create: `apps/worker/src/mcp/tools/tickets.ts`
- Create: `apps/worker/src/mcp/tools/tickets.test.ts`
- Modify: `apps/worker/src/db/queries/runs-read.ts`
- Modify: `apps/worker/src/db/queries/runs-read.test.ts`
- Modify: `apps/worker/src/mcp/server.ts`
- Modify: `apps/worker/src/mcp/server.test.ts`

**Interfaces:**

```ts
export const TicketGetInput = z.object({
  ticketKey: z.string().trim().min(1).max(100),
  includeComments: z.boolean().default(false),
  commentsLimit: z.number().int().min(1).max(50).default(20),
});

export const TicketRunsInput = z.object({
  ticketKey: z.string().trim().min(1).max(100),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
});

export function registerTicketTools(server: McpServer, deps: McpToolDependencies): void;
export async function listRunSummariesForTicketPage(input: {
  db: Db;
  ticketKey: string;
  after: { effectiveAt: string; runId: string } | null;
  limit: number;
  now: Date;
  jiraBaseUrl: string;
  modelFallback: string;
}): Promise<{ runs: Run[]; next: { effectiveAt: string; runId: string } | null }>;
```

- [ ] **Step 1: Write failing tool tests**

Mock `IssueTrackerAdapter.fetchTicket()` with comments containing injection and secrets. Mock durable run history. Assert comments are omitted by default, explicitly included comments are redacted/truncated, ticket trust is `external_untrusted`, and ticket-not-found maps to public `NOT_FOUND`.

Assert `tickets.list_runs` returns newest-first summaries, opaque cursor, no more than requested limit, and rejects a token whose organization is not the deployment organization before calling the query.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter worker exec vitest run src/mcp/tools/tickets.test.ts src/mcp/server.test.ts`

Expected: FAIL because ticket tools are not registered.

- [ ] **Step 3: Implement thin handlers**

`tickets.get` calls only `deps.adapters.issueTracker.fetchTicket(ticketKey)`. Add `listRunSummariesForTicketPage()` beside `listRunsForTicket()` so MCP paginates in SQL by the stable tuple `(coalesce(startedAt, firstSeenAt), runId)` without loading the full history; retain `listRunsForTicket()` unchanged for dashboard totals. The MCP cursor is base64url canonical JSON of that tuple and rejects invalid timestamp/run ID shapes. Do not call `/api/v1` over HTTP and do not duplicate Jira logic.

Register annotations:

```ts
{
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}
```

Every call passes `authorizeTool`, `sanitizeMcpData` and `writeMcpAudit`.

- [ ] **Step 4: Run tool tests**

Run: `pnpm --filter worker exec vitest run src/mcp/tools/tickets.test.ts src/mcp/server.test.ts src/db/queries/runs-read.test.ts && pnpm --filter worker typecheck`

Expected: PASS; existing ticket-run query tests are unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/mcp/tools/tickets.ts apps/worker/src/mcp/tools/tickets.test.ts apps/worker/src/db/queries/runs-read.ts apps/worker/src/db/queries/runs-read.test.ts apps/worker/src/mcp/server.ts apps/worker/src/mcp/server.test.ts
git commit -m "feat(worker): expose ticket reads through MCP"
```

### Task 7: Add run status, trace, result and deterministic diagnosis

**Files:**

- Create: `apps/worker/src/mcp/tools/runs.ts`
- Create: `apps/worker/src/mcp/tools/runs.test.ts`
- Create: `apps/worker/src/mcp/run-diagnosis.ts`
- Create: `apps/worker/src/mcp/run-diagnosis.test.ts`
- Create: `apps/worker/src/run-detail/service.ts`
- Create: `apps/worker/src/run-detail/service.test.ts`
- Modify: `apps/worker/src/routes/api/v1/runs/[runId].get.ts`
- Modify: `apps/worker/src/mcp/server.ts`

**Interfaces:**

```ts
export const RunIdInput = z.object({ runId: z.string().trim().min(1).max(200) });
export const RunTraceInput = RunIdInput.extend({
  level: z.enum(["summary", "detailed"]).default("summary"),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

export type RunDiagnosis = {
  classification:
    | "healthy"
    | "waiting"
    | "workflow_validation"
    | "dependency_auth"
    | "dependency_rate_limit"
    | "sandbox_timeout"
    | "capacity"
    | "cancelled"
    | "unknown_failure";
  confidence: "high" | "medium" | "low";
  summary: string;
  evidence: Array<{ kind: string; ref: string; safeMessage: string }>;
  nextActions: Array<{ action: string; tool?: McpToolName; reason: string }>;
};

export function diagnoseRun(input: SanitizedRunEvidence): RunDiagnosis;
export function registerRunTools(server: McpServer, deps: McpToolDependencies): void;
export async function loadRunDetail(input: {
  db: Db;
  world: RunDetailSource;
  runId: string;
  organizationId: string;
  jiraBaseUrl: string;
  modelFallback: string;
}): Promise<RunDetailResponse>;
```

- [ ] **Step 1: Write failing diagnosis table tests**

Provide fixtures for workflow validation error, Jira 401/403, provider 429, sandbox deadline, capacity blocker, cancelled status, clean running state and unrecognized failure. Assert diagnosis never embeds raw log lines and every evidence ref points to a run/attempt/node identifier.

- [ ] **Step 2: Write failing tool tests**

Cover the extracted `loadRunDetail()` service’s live-world path, durable fallback and sanitizer. Cover non-terminal `runs.get` with `pollAfterMs`, terminal success/failure, expired/not-captured trace, paginated `getRunReplay()`, detailed attempt output redaction, `runs.result` before terminal (`CONFLICT`) and terminal result, plus cross-org replay returning `NOT_FOUND`.

- [ ] **Step 3: Run and verify failure**

Run: `pnpm --filter worker exec vitest run src/mcp/run-diagnosis.test.ts src/mcp/tools/runs.test.ts src/run-detail/service.test.ts`

Expected: FAIL because modules are absent.

- [ ] **Step 4: Implement deterministic mapping**

Extract the existing live-world + durable-fallback logic from `routes/api/v1/runs/[runId].get.ts` into `run-detail/service.ts`; keep the H3 route responsible only for auth, parameters, cache headers and HTTP error mapping. Both the route and MCP then reuse:

- `fetchRunDetailFromDb()` and `sanitizeRunDetailForResponse()` for header/steps;
- `getRunReplay()` and `getRunReplayAttempt()` for org-scoped trace evidence;
- existing replay envelopes for bounded sanitized input/output/logs.

`runs.result` returns `terminal: false` and public `CONFLICT` until status is `success|failed|blocked`; for terminal states it returns the sanitized run summary plus final attempt outcomes and artifact references already present in durable data. It must not fetch arbitrary artifact URLs.

- [ ] **Step 5: Register all four read-only tools**

Use `readOnlyHint=true`, `openWorldHint=false` for durable run data, except trace fields explicitly tagged `external_untrusted`. Audit each call with run ID as the only target reference.

- [ ] **Step 6: Run run-domain verification**

Run: `pnpm --filter worker exec vitest run src/mcp/run-diagnosis.test.ts src/mcp/tools/runs.test.ts src/run-detail/service.test.ts src/db/queries/run-detail-read.test.ts src/run-observability/store.test.ts src/lib/overview/sanitize-run-detail.test.ts && pnpm --filter worker typecheck`

Expected: PASS; seeded secret values are absent from snapshots and console output.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/mcp/tools/runs.ts apps/worker/src/mcp/tools/runs.test.ts apps/worker/src/mcp/run-diagnosis.ts apps/worker/src/mcp/run-diagnosis.test.ts apps/worker/src/run-detail/service.ts apps/worker/src/run-detail/service.test.ts 'apps/worker/src/routes/api/v1/runs/[runId].get.ts' apps/worker/src/mcp/server.ts
git commit -m "feat(worker): expose run diagnosis through MCP"
```

### Task 8: Add preflight and idempotent workflow dispatch

**Files:**

- Create: `apps/worker/src/mcp/tools/workflows.ts`
- Create: `apps/worker/src/mcp/tools/workflows.test.ts`
- Modify: `apps/worker/src/mcp/server.ts`

**Interfaces:**

```ts
export const WorkflowDispatchPreflightInput = z.object({
  workflowId: z.number().int().positive(),
  triggerNodeId: z.string().trim().min(1).max(200),
  input: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ticket"), ticketKey: z.string().trim().min(1).max(100) }),
    z.object({ kind: z.literal("pull_request"), url: z.string().url().max(2_048) }),
  ]),
  expectedDeployedVersion: z.number().int().positive(),
});

export const WorkflowDispatchInput = WorkflowDispatchPreflightInput.extend({
  preflightDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  idempotencyKey: z.string().uuid(),
});
```

- [ ] **Step 1: Write failing preflight tests**

Assert admin/owner success, member forbidden, wrong deployed version conflict, active-run/capacity blockers, canonical preflight digest stability and no write to idempotency/audit mutation state for a read-only preflight.

- [ ] **Step 2: Write failing dispatch tests**

Assert successful dispatch returns `runId`, same key/same payload returns the same `runId`, same key/different payload gives `IDEMPOTENCY_CONFLICT`, changed deployed version gives `CONFLICT`, preflight digest mismatch gives `VALIDATION_FAILED`, and audit failure prevents calling `dispatchManualWorkflow()`.

- [ ] **Step 3: Run and verify failure**

Run: `pnpm --filter worker exec vitest run src/mcp/tools/workflows.test.ts`

Expected: FAIL because workflow tools are absent.

- [ ] **Step 4: Implement thin service calls**

`workflows.dispatch_preflight` calls `preflightManualDispatch()` and hashes the canonical tuple:

```ts
{
  workflowId,
  triggerNodeId,
  input: preflight.input,
  deployedVersion: preflight.deployedVersion,
  runnable: preflight.runnable,
  blocker: preflight.blocker ?? null,
}
```

`workflows.dispatch` recalculates preflight, requires matching digest and version, then calls `dispatchManualWorkflow()` with `request.requestId = idempotencyKey`. This deliberately reuses the existing durable manual-dispatch idempotency while the MCP idempotency row supplies actor/client/tool namespace and safe replay.

- [ ] **Step 5: Apply mutation ordering**

Order is fixed:

1. authenticate and authorize;
2. validate schema and preflight digest;
3. begin MCP idempotency;
4. append audit intent; fail closed if it fails;
5. call manual dispatch;
6. complete idempotency;
7. append audit outcome;
8. return sanitized envelope.

Use annotations `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`.

- [ ] **Step 6: Run dispatch verification**

Run: `pnpm --filter worker exec vitest run src/mcp/tools/workflows.test.ts src/manual-dispatch/service.test.ts src/manual-dispatch/routes.test.ts && pnpm --filter worker typecheck`

Expected: PASS; existing dashboard manual-dispatch behavior remains unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/mcp/tools/workflows.ts apps/worker/src/mcp/tools/workflows.test.ts apps/worker/src/mcp/server.ts
git commit -m "feat(worker): dispatch workflows through MCP"
```

### Task 9: Generate the contract artifact and readiness endpoint

**Files:**

- Create: `apps/worker/src/mcp/tool-catalog.ts`
- Create: `apps/worker/src/mcp/tool-catalog.test.ts`
- Create: `apps/worker/scripts/generate-mcp-contract.ts`
- Create: `apps/worker/src/mcp/contracts/mcp-contract.json`
- Create: `apps/worker/src/routes/api/v1/system/mcp-readiness.get.ts`
- Create: `apps/worker/src/routes/api/v1/system/mcp-readiness.test.ts`
- Modify: `apps/worker/package.json`

**Interfaces:**

```ts
export type McpContractArtifact = {
  serverVersion: string;
  protocolVersions: ["2025-11-25"];
  endpointPath: "/mcp";
  tools: Array<{
    name: McpToolName;
    inputSchema: object;
    outputSchema: object;
    annotations: object;
  }>;
  resources: string[];
  errorCodes: McpErrorCode[];
  contractHash: string;
  minimumDatabaseRevision: "0044_mcp_foundation";
};
```

- [ ] **Step 1: Write failing determinism tests**

Generate twice with tool registration in different insertion order and assert byte-identical canonical JSON/hash. Assert every policy entry has exactly one catalog entry, every mutation declares `idempotentHint`, and `serverInfo.version` equals artifact version.

- [ ] **Step 2: Write failing readiness tests**

Cover disabled, DB revision missing, OAuth metadata/JWKS unavailable, contract mismatch and ready. The response may expose only status, version, protocol versions, contract hash and check names; no host secrets or database URL.

- [ ] **Step 3: Run and verify failure**

Run: `pnpm --filter worker exec vitest run src/mcp/tool-catalog.test.ts src/routes/api/v1/system/mcp-readiness.test.ts`

Expected: FAIL because artifact and route are absent.

- [ ] **Step 4: Implement generation and committed drift gate**

Add scripts:

```json
"mcp:contract": "tsx scripts/generate-mcp-contract.ts",
"mcp:contract:check": "tsx scripts/generate-mcp-contract.ts --check"
```

`--check` generates in memory and exits non-zero on any byte difference from committed JSON. It must never rewrite during CI.

- [ ] **Step 5: Implement authenticated readiness**

Use existing session/service auth suitable for deployment automation and return `503` when any check fails. Keep `/health` unchanged as liveness.

- [ ] **Step 6: Run artifact verification**

Run: `pnpm --filter worker mcp:contract && pnpm --filter worker mcp:contract:check && pnpm --filter worker exec vitest run src/mcp/tool-catalog.test.ts src/routes/api/v1/system/mcp-readiness.test.ts && pnpm --filter worker typecheck`

Expected: PASS and `git diff --exit-code -- apps/worker/src/mcp/contracts/mcp-contract.json` after the second command.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/mcp/tool-catalog.ts apps/worker/src/mcp/tool-catalog.test.ts apps/worker/scripts/generate-mcp-contract.ts apps/worker/src/mcp/contracts/mcp-contract.json apps/worker/src/routes/api/v1/system/mcp-readiness.get.ts apps/worker/src/routes/api/v1/system/mcp-readiness.test.ts apps/worker/package.json
git commit -m "feat(worker): publish the MCP contract manifest"
```

### Task 10: Build a real HTTP smoke client

**Files:**

- Create: `apps/worker/scripts/mcp-smoke.ts`
- Create: `apps/worker/scripts/mcp-smoke.test.ts`
- Modify: `apps/worker/package.json`

**Interfaces:**

```ts
type McpSmokeConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  suite: "readonly" | "dispatch-canary";
  ticketKey: string;
  workflowId?: number;
  triggerNodeId?: string;
  timeoutMs: number;
};

type McpSmokeEvidence = {
  passed: boolean;
  serverVersion: string;
  protocolVersion: "2025-11-25";
  contractHash: string;
  checks: Array<{ name: string; passed: boolean; latencyMs: number; safeError?: string }>;
  runId?: string;
  terminalStatus?: string;
};
```

- [ ] **Step 1: Write failing mocked-server tests**

Cover discovery, client credentials token exchange with `resource=${config.baseUrl}/mcp`, initialize, tools/list, ticket/run reads, dispatch preflight, same-key replay, polling to terminal, result/diagnose, timeout and cleanup-safe failure output. Assert stdout is one JSON evidence document and stderr never includes secret/token.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter worker exec vitest run scripts/mcp-smoke.test.ts`

Expected: FAIL because the script is absent.

- [ ] **Step 3: Implement the smoke sequence with the SDK client**

Use `StreamableHTTPClientTransport` and `Client`; do not import `createMcpServer()` or tool handlers. Fixed sequence:

1. RFC 9728 and AS discovery;
2. client credentials token with canonical resource;
3. connect/initialize `2025-11-25`;
4. verify `system.capabilities` and committed contract hash;
5. `tickets.get` and `tickets.list_runs`;
6. if a run exists: get/trace/result-or-nonterminal/diagnose;
7. for dispatch suite: preflight, dispatch, identical retry, poll with server `pollAfterMs` capped at 5s, result/diagnose;
8. print safe JSON evidence.

- [ ] **Step 4: Add package command and test**

```json
"mcp:smoke": "tsx scripts/mcp-smoke.ts"
```

Run: `pnpm --filter worker exec vitest run scripts/mcp-smoke.test.ts && pnpm --filter worker typecheck`

Expected: PASS; negative fixtures prove no secret leakage.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/scripts/mcp-smoke.ts apps/worker/scripts/mcp-smoke.test.ts apps/worker/package.json
git commit -m "test(worker): add MCP end-to-end smoke client"
```

### Task 11: Add internal dogfood GitHub Action

**Files:**

- Create: `.github/actions/mcp-release-smoke/action.yml`
- Create: `.github/workflows/mcp-dogfood.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/release-notes/workflows.test.ts`

**Interfaces:**

Composite Action inputs:

```yaml
inputs:
  base-url: { required: true }
  oauth-client-id: { required: true }
  oauth-client-secret: { required: true }
  suite: { required: true, default: readonly }
  ticket-key: { required: true }
  workflow-id: { required: false }
  trigger-node-id: { required: false }
outputs:
  evidence-file:
    value: ${{ steps.smoke.outputs.evidence-file }}
```

- [ ] **Step 1: Add failing behavioral workflow tests**

Parse the Action and workflow YAML, then execute the composite Action's extracted shell block in a temporary environment with a fake `pnpm` on `PATH`. Assert that it invokes `pnpm --filter worker mcp:smoke`, writes evidence under `$RUNNER_TEMP`, masks the client secret before use, emits exactly one `evidence-file` output, and does not print credentials or dump the environment. Keep the existing repository workflow-validation style for structural assertions, but do not make raw source-text matching the primary proof of behavior.

- [ ] **Step 2: Run local workflow validation and verify failure**

Run: `pnpm test:release-notes -- --test-name-pattern='MCP dogfood'`

Expected: FAIL because the action/workflow is missing.

- [ ] **Step 3: Create the composite action**

The Action installs the already locked repo dependencies, calls the smoke script, appends a single `evidence-file` output to `$GITHUB_OUTPUT`, and uploads no secret-bearing raw HTTP transcript. It receives values as inputs; it does not name or read repository secrets directly.

- [ ] **Step 4: Create internal workflow without guessing deployment metadata**

Triggers: `workflow_dispatch`, daily `schedule`, and GitHub `deployment_status`. The deployment-status job runs only when the deployment succeeds and `github.event.deployment.environment == vars.INTERNAL_WORKER_DEPLOYMENT_ENVIRONMENT`; this variable is populated with the discovered internal worker deployment environment and prevents accidental dogfooding of dashboard or demo.

Create a new GitHub Environment named `mcp-dogfood-internal` with proposed, MCP-owned names: variables `MCP_BASE_URL`, `MCP_SMOKE_TICKET_KEY`, `MCP_SMOKE_WORKFLOW_ID`, `MCP_SMOKE_TRIGGER_NODE_ID`, `INTERNAL_WORKER_DEPLOYMENT_ENVIRONMENT`; secrets `MCP_SMOKE_CLIENT_ID`, `MCP_SMOKE_CLIENT_SECRET`. These are new configuration contracts, not assumptions about existing names. Map only these values into Action inputs and mask both credential values before execution.

- [ ] **Step 5: Gate CI on contract tests**

Add `pnpm --filter worker mcp:contract:check` and focused MCP tests to `.github/workflows/ci.yml` after worker typecheck. Do not run live smoke in pull requests.

- [ ] **Step 6: Verify syntax and local tests**

Run: `pnpm test:release-notes -- --test-name-pattern='MCP dogfood' && pnpm --filter worker mcp:contract:check && pnpm --filter worker exec vitest run src/mcp scripts/mcp-smoke.test.ts && pnpm --filter worker typecheck`

Expected: PASS. Inspect action YAML and confirm all `${{ inputs.* }}` values are quoted and client secret is masked.

- [ ] **Step 7: Commit**

```bash
git add .github/actions/mcp-release-smoke/action.yml .github/workflows/mcp-dogfood.yml .github/workflows/ci.yml scripts/release-notes/workflows.test.ts
git commit -m "ci: dogfood the remote MCP deployment"
```

### Task 12: Integrate destination Artur release and publish the versioned artifact

**Repositories and files:**

- Source modify: `.github/workflows/prepare-artur-release.yml`
- Source modify: `.github/workflows/sync-artur-release.yml`
- Source modify: `scripts/release-notes/types.ts`
- Source modify: `scripts/release-notes/render.ts`
- Source modify: `scripts/release-notes/render.test.ts`
- Source modify: `scripts/release-notes/manifest.ts`
- Source modify: `scripts/release-notes/manifest.test.ts`
- Source modify: `scripts/release-notes/sync.ts`
- Source modify: `scripts/release-notes/sync.test.ts`
- Source modify: `scripts/release-notes/cli.ts`
- Source modify: `scripts/release-notes/workflows.test.ts`
- Source modify: `scripts/release-notes/cli.test.ts`
- Destination create: `.github/actions/mcp-release-smoke/action.yml`
- Destination modify: `.github/workflows/validate-artur-release.yml`
- Destination modify: `.github/workflows/publish-artur-release.yml`
- Destination modify: `.github/scripts/publish-artur-release.mjs`
- Destination modify: `.github/scripts/publish-artur-release.test.mjs`
- Destination modify: `.github/scripts/release-workflows.test.mjs`

The destination repository name is not guessed at execution time. Resolve it from the existing source release workflow/docs, assert it equals the configured release target, and stop on mismatch.

**Interfaces:**

```ts
type ReleaseManifestMcp = {
  endpoint: string;
  serverVersion: string;
  protocolVersions: ["2025-11-25"];
  contractHash: string;
  minimumDatabaseRevision: "0044_mcp_foundation";
  smoke: {
    suite: "readonly" | "dispatch-canary";
    passed: boolean;
    runId?: string;
    evidenceSha256: string;
  };
};
```

- [ ] **Step 1: Add source release validation tests/checks**

Extend `ReleaseFileMetadata`, `ApprovedSourceRelease` and `SyncResult` with optional `mcp: { serverVersion, contractHash, protocolVersions, minimumDatabaseRevision }`. Require this block when `apps/worker/src/mcp/contracts/mcp-contract.json` exists at the target source commit; require an explicit compatibility note in the rendered release only when its hash differs from the previous source ref. Assert sync includes `apps/worker/src/mcp/**`, routes, migration, scripts and committed contract while preserving the destination-owned `.github/**` rule.

Run: `pnpm test:release-notes`

Expected: FAIL on the new MCP metadata, workflow and sync assertions.

- [ ] **Step 2: Modify source workflows**

`prepare-artur-release.yml` runs `pnpm --filter worker mcp:contract:check` and the release-notes CLI reads the committed target contract into the signed release metadata. `sync-artur-release.yml` verifies the copied snapshot’s contract hash after sync but does not deploy or use destination credentials.

Run: `pnpm test:release-notes && pnpm typecheck:release-notes && pnpm --filter worker mcp:contract:check`

Expected: PASS with unchanged behavior for historical release notes that predate MCP metadata.

- [ ] **Step 3: Create a destination PR for destination-owned Action/workflows**

The destination composite Action calls the snapshot’s `apps/worker/scripts/mcp-smoke.ts`; it contains no duplicated domain logic. Add an `observe-mcp-preview` command to `.github/scripts/publish-artur-release.mjs` that waits for the successful worker deployment status for the PR head SHA and returns its verified `environment_url`; it rejects dashboard/demo environments. `validate-artur-release.yml` runs read-only smoke against that URL. `publish-artur-release.yml` runs dispatch-canary against the already configured `ARTUR_WORKER_URL` after production deployment and before tag/Release creation.

Create destination GitHub Environment `artur-release-validation` with proposed variables `ARTUR_WORKER_DEPLOYMENT_ENVIRONMENT`, `MCP_SMOKE_TICKET_KEY` and secrets `MCP_SMOKE_CLIENT_ID`, `MCP_SMOKE_CLIENT_SECRET`. Add variables `MCP_SMOKE_TICKET_KEY`, `MCP_SMOKE_WORKFLOW_ID`, `MCP_SMOKE_TRIGGER_NODE_ID` plus the same two secrets to the existing `artur-production` environment. These are new MCP-owned configuration names.

- [ ] **Step 4: Extend release manifest and asset publication**

Add the exact `mcp` object above. Attach immutable `ai-workflow-mcp-manifest.json` beside `release-manifest.json`; compute `evidenceSha256` from the safe smoke JSON. Fail if live capabilities, committed contract and manifest versions/hashes differ.

Run in the destination checkout: `node --test .github/scripts/publish-artur-release.test.mjs .github/scripts/release-workflows.test.mjs`

Expected: PASS for preview discovery, production gate, manifest serialization and asset list; negative tests reject wrong environment, wrong SHA, contract mismatch and failed smoke.

- [ ] **Step 5: Verify release behavior on a destination preview**

Expected sequence: destination PR validation → Vercel preview ready → OAuth discovery/token → read-only smoke → merge → production ready → dispatch-canary → manifest/tag/release. Any failed MCP step prevents tag and GitHub Release creation.

- [ ] **Step 6: Commit source and destination changes separately**

Source commit:

```bash
git add .github/workflows/prepare-artur-release.yml .github/workflows/sync-artur-release.yml scripts/release-notes/types.ts scripts/release-notes/render.ts scripts/release-notes/render.test.ts scripts/release-notes/manifest.ts scripts/release-notes/manifest.test.ts scripts/release-notes/sync.ts scripts/release-notes/sync.test.ts scripts/release-notes/cli.ts scripts/release-notes/cli.test.ts scripts/release-notes/workflows.test.ts
git commit -m "ci: include MCP contract in Artur release preparation"
```

Destination commit is created in the destination repository only after its existing AGENTS/instructions and dirty state are inspected:

```bash
git add .github/actions/mcp-release-smoke/action.yml .github/workflows/validate-artur-release.yml .github/workflows/publish-artur-release.yml .github/scripts/publish-artur-release.mjs .github/scripts/publish-artur-release.test.mjs .github/scripts/release-workflows.test.mjs
git commit -m "ci: verify MCP during Artur release"
```

### Task 13: Execute internal dogfood acceptance and freeze the slice

**Files:**

- Create: `docs/qa/mcp-dogfood-acceptance.md`

**Interfaces:** No new runtime interfaces. This task accepts or rejects the accumulated slice.

- [ ] **Step 1: Run the complete local gate**

Run:

```bash
pnpm --filter worker mcp:contract:check
pnpm --filter worker test
pnpm --filter worker typecheck
pnpm --filter worker build
```

Expected: all commands exit `0`; migration and auth seed succeed in build; no contract artifact drift.

- [ ] **Step 2: Inspect scope and secrets**

Run:

```bash
git diff --check
mcp_slice_base_ref=$(git merge-base origin/main HEAD)
git diff --name-only "$mcp_slice_base_ref"...HEAD
rg -n "Bearer |client_secret|BEGIN .*PRIVATE KEY|gh[pousr]_" apps/worker/src/mcp apps/worker/scripts/mcp-smoke.ts .github/actions/mcp-release-smoke
```

Expected: changed files match this plan; secret-pattern search finds only test fixtures/redaction patterns, never a live value. Before Task 1, record `git rev-parse HEAD` in the execution log and use that recorded SHA instead of the merge-base command if the implementation branch already contains unrelated commits.

- [ ] **Step 3: Deploy disabled to internal worker**

Deploy the accumulated commit to the existing internal `ai-workflow-app` with expand migration and `MCP_ENABLED=false`. Verify `/health` and existing dashboard/API/webhook/cron smoke before enabling MCP.

- [ ] **Step 4: Enable read-only and test real clients**

Set `MCP_ENABLED=true`, create one public OAuth client for Claude Code/Codex callbacks and one least-privilege confidential smoke client in the internal organization. Run discovery and the readonly suite. Verify audit rows, redaction and no token passthrough.

- [ ] **Step 5: Enable dispatch scope and run canary**

Grant `runs:dispatch` only to the dogfood admin and smoke client. Execute preflight → dispatch → identical retry → polling → trace → terminal result → diagnosis. Confirm both dispatch calls return the same run ID and exactly one workflow starts.

- [ ] **Step 6: Exercise negative acceptance cases**

Verify member dispatch denied, missing scope, wrong audience, expired token, cross-deployment token, changed deployed version, reused key with changed payload, hostile ticket/log content, audit DB failure, and `MCP_ENABLED=false` rollback.

- [ ] **Step 7: Record evidence and freeze contract**

Store only safe JSON evidence and hashes in `docs/qa/mcp-dogfood-acceptance.md`. Record internal deployment ID, server version, protocol, contract hash, smoke run ID, terminal status and rollback check. Do not store access tokens, client secrets, raw logs or complete ticket content.

- [ ] **Step 8: Final acceptance commit**

```bash
git add docs/qa/mcp-dogfood-acceptance.md
git commit -m "docs: record MCP dogfood acceptance"
```

## Subsequent independently planned increments

The first slice is complete only after Task 13. Continue in this order, producing a separate spec/plan or plan addendum for each independently reviewable increment:

1. Ticket mutations: create, update, comment, labels and preview/confirm transition.
2. Workflow authoring: create/draft/validate/publish/rollback/lifecycle with branch/loop scenario tests.
3. Harness and skills: profile drafts/publish, remote/local discovery, import/refresh and workflow assignments.
4. Memory: list/get, secret scanning, preview/confirm update and owner-only delete.
5. Dogfood service tools: suite registry, async run results, isolated fixtures and idempotent cleanup.
6. Customer rollout automation: per-deployment inventory, OAuth clients, canary scopes, smoke, observability, kill switch, version compatibility and expand/contract cleanup.

Each increment must reuse `McpActorContext`, policy, audit, idempotency, sanitization and contract generation from this slice; creating a second security path is a plan violation.

## Final acceptance checklist

- [ ] `/mcp` works from Claude Code and Codex without dashboard access.
- [ ] OAuth PKCE and service-client flows validate issuer, audience, scopes, role and deployment organization.
- [ ] Ticket/run/trace/result/diagnosis responses are bounded, redacted and marked by trust level.
- [ ] Dispatch uses existing application services, requires preflight/version/idempotency and starts exactly one run on retries.
- [ ] Audit is complete and contains no raw sensitive payloads.
- [ ] Contract hash is deterministic and identical in server capabilities, committed artifact, smoke evidence and release manifest.
- [ ] Internal dogfood, destination preview and production release smoke are blocking gates.
- [ ] Kill switch and immutable deployment rollback are demonstrated.
- [ ] No user-owned dirty worktree changes were overwritten or included accidentally.
