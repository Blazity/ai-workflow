import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin",
  env: { DASHBOARD_ORG_SLUG: "ai-workflow", ANTHROPIC_API_KEY: "anthropic-key" },
  providers: [] as unknown[],
  directory: undefined as unknown,
}));

const mocks = vi.hoisted(() => ({
  generateProviderText: vi.fn(),
  loadProfile: vi.fn(),
}));

vi.mock("../../../infra/vcs-config.js", () => ({
  env: state.env,
  getConfiguredVcsProviders: () => state.providers,
  getVcsProviderConfig: () => state.providers[0],
}));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../services/auth/auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: state.sessionUserId },
        session: { id: "session_test" },
      })),
    },
  },
}));
vi.mock("../../../services/repository-discovery/index.js", () => ({
  listCachedRepositoryDirectory: vi.fn(async () => state.directory),
}));
vi.mock("../../../infra/llm.js", () => ({
  generateProviderText: mocks.generateProviderText,
}));
vi.mock("../../../adapters/vcs/create-vcs.js", () => ({
  createVCS: vi.fn(),
  createVCSForRepository: vi.fn(),
  createRepositoryProfileSource: vi.fn(() => ({ loadProfile: mocks.loadProfile })),
}));

const importPreviewPost = (await import("./repository-catalog/import-preview.post.js")).default;
const importPost = (await import("./repository-catalog/import.post.js")).default;
const suggestPost = (await import("./repository-catalog/suggest.post.js")).default;
const { upsertRepositoryProfile } = await import(
  "../../../db/repositories/repository-catalog.js"
);
const { listRepositorySuggestions } = await import(
  "../../../db/repositories/repository-suggestions.js"
);
const { listRepositoryProfileVersionRows } = await import(
  "../../../db/repositories/repository-catalog.js"
);
const {
  REPOSITORY_SUGGESTION_RATE_LIMIT,
  resetRepositorySuggestionsInFlightForTests,
} = await import("../../../services/repository-catalog/index.js");
const { insertRepositorySuggestion } = await import(
  "../../../db/repositories/repository-suggestions.js"
);

let db: Db;
let repositoryId: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function post(route: any, body: unknown) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app)(
    new Request("http://worker.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const BUNDLE = {
  provider: "github",
  repoPath: "acme/api",
  defaultBranch: "main",
  description: "The API",
  readme: "# acme api",
  manifests: [{ path: "package.json", content: '{"scripts":{"test":"vitest"}}' }],
  lockfiles: ["pnpm-lock.yaml"],
  ciDefinitions: [],
  languages: ["TypeScript"],
  truncated: [],
};

const ANSWER = {
  description: "The team's public API.",
  rules: "- never force push",
  groups: [{ name: "test", commands: ["pnpm test"] }],
};

beforeEach(async () => {
  vi.clearAllMocks();
  resetRepositorySuggestionsInFlightForTests();
  state.sessionUserId = "user_admin";
  state.providers = [
    { kind: "github", auth: { appId: 1, privateKeyBase64: "cGVt", installationId: 2 } },
  ];
  state.directory = {
    repositories: [
      {
        provider: "github",
        repoPath: "Acme/Api",
        name: "Api",
        owner: "Acme",
        defaultBranch: "main",
        private: true,
        archived: false,
      },
      {
        provider: "github",
        repoPath: "acme/web",
        name: "web",
        owner: "acme",
        defaultBranch: "main",
        private: true,
        archived: false,
      },
    ],
    providers: [{ provider: "github", status: "ready" }],
  };
  mocks.loadProfile.mockResolvedValue(BUNDLE);

  db = await createTestDb();
  state.db = db;
  await db
    .insert(organization)
    .values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    { id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true },
    { id: "user_member", name: "Member", email: "member@example.com", emailVerified: true },
  ]);
  await db.insert(member).values([
    { id: "member_admin", organizationId: "org_aiw", userId: "user_admin", role: "admin" },
    { id: "member_member", organizationId: "org_aiw", userId: "user_member", role: "member" },
  ]);
  const saved = await upsertRepositoryProfile(db, {
    provider: "github",
    path: "acme/api",
    description: "",
    rules: "",
    relationships: [],
    scriptGroups: null,
    gateGroups: null,
    actorId: "user_admin",
    actorLabel: "Admin",
    reason: "",
  });
  repositoryId = saved.id;
});

describe("POST /api/v1/repository-catalog/import-preview", () => {
  it("lists the installation with what the catalog already holds, for any role", async () => {
    state.sessionUserId = "user_member";
    const res = await post(importPreviewPost, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repositories).toEqual([
      expect.objectContaining({ key: "github:acme/api", path: "Acme/Api", inCatalog: true }),
      expect.objectContaining({ key: "github:acme/web", path: "acme/web", inCatalog: false }),
    ]);
    expect(body.providers).toEqual([{ provider: "github", status: "ready" }]);
  });

  it("refuses a body carrying anything at all", async () => {
    const res = await post(importPreviewPost, { provider: "github" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/repository-catalog/import", () => {
  it("creates the selected rows and reports what it skipped", async () => {
    const res = await post(importPost, {
      repositoryKeys: ["github:acme/web", "github:ghost/repo"],
      enabled: true,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.skipped).toEqual(["github:ghost/repo"]);
    expect(body.alreadyPresent).toEqual([]);
    expect(body.repositories.map((entry: { path: string }) => entry.path)).toEqual([
      "acme/api",
      "acme/web",
    ]);
  });

  it("answers a retryable 503 when a provider owning a selected key could not be listed", async () => {
    state.directory = {
      repositories: [],
      providers: [{ provider: "github", status: "error", error: "401 from GitHub" }],
    };

    const res = await post(importPost, {
      repositoryKeys: ["github:acme/web"],
      enabled: false,
    });

    expect(res.status).toBe(503);
    expect((await res.json()).statusMessage).toContain("provider_unavailable");
  });

  it("gives a member 403 and writes nothing", async () => {
    state.sessionUserId = "user_member";
    const res = await post(importPost, { repositoryKeys: ["github:acme/web"], enabled: true });

    expect(res.status).toBe(403);
    const preview = await (await post(importPreviewPost, {})).json();
    expect(
      preview.repositories.find(
        (candidate: { key: string }) => candidate.key === "github:acme/web",
      ).inCatalog,
    ).toBe(false);
  });
});

describe("POST /api/v1/repository-catalog/suggest", () => {
  it("answers a proposal in the profile shape and records the call", async () => {
    mocks.generateProviderText.mockResolvedValue({
      object: ANSWER,
      text: "",
      usage: { inputTokens: 1_000, outputTokens: 40, cachedTokens: 10 },
    });

    const res = await post(suggestPost, { repositoryId });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      proposal: {
        source: "suggested",
        description: "The team's public API.",
        rules: "- never force push",
        scriptGroups: [{ name: "test", commands: ["pnpm test"], provenance: "model" }],
      },
      droppedGroups: [],
      model: "claude-haiku-4-5",
      usage: { inputTokens: 1_000, cachedTokens: 10, outputTokens: 40 },
      costUsd: null,
    });

    const [call] = mocks.generateProviderText.mock.calls;
    expect(call?.[0]).toMatchObject({
      model: "claude-haiku-4-5",
      provider: "claude",
      timeoutMs: 90_000,
      credentials: { anthropicApiKey: "anthropic-key" },
    });
    expect(call?.[0].prompt).toContain("# acme api");

    const rows = await listRepositorySuggestions(db, repositoryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "proposed",
      model: "claude-haiku-4-5",
      actorId: "user_admin",
      tokensInput: 1_000,
      costUsd: null,
    });
  });

  it("answers a retryable 503 and records a timeout when the provider does not finish in time", async () => {
    mocks.generateProviderText.mockRejectedValue(
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    );

    const res = await post(suggestPost, { repositoryId });

    expect(res.status).toBe(503);
    expect((await res.json()).statusMessage).toBe("suggestion_timed_out");
    const rows = await listRepositorySuggestions(db, repositoryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("timeout");
  });

  // The in-flight join is asserted where it is deterministic, in
  // `services/repository-catalog/suggest.test.ts`: two requests racing through
  // the auth hop would join or not depending on how long a session read took,
  // which is a test that passes for the wrong reason.

  it("refuses a malformed answer, writes no profile, and records the outcome", async () => {
    mocks.generateProviderText.mockResolvedValue({
      object: { description: "ok", groups: "every check we have" },
      text: "",
      usage: { inputTokens: 10, outputTokens: 1, cachedTokens: 0 },
    });

    const res = await post(suggestPost, { repositoryId });

    expect(res.status).toBe(502);
    expect((await res.json()).statusMessage).toBe("suggestion_malformed");
    const rows = await listRepositorySuggestions(db, repositoryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "malformed", tokensInput: 10 });
    // The profile is exactly where the seed left it: one version, no rewrite.
    expect(await listRepositoryProfileVersionRows(db, repositoryId)).toHaveLength(1);
  });

  it("never puts the provider's own words in the body it answers with", async () => {
    mocks.generateProviderText.mockRejectedValue(
      new Error("401 from https://api.anthropic.com with x-api-key sk-ant-secret"),
    );

    const res = await post(suggestPost, { repositoryId });

    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("suggestion_failed");
    expect(body).not.toContain("api.anthropic.com");
    expect(body).not.toContain("sk-ant-secret");
    // The message is kept where it is useful and not public: the row.
    const rows = await listRepositorySuggestions(db, repositoryId);
    expect(rows[0]?.error).toContain("provider call:");
  });

  it("answers 404 when the provider no longer has the repository", async () => {
    const { RepositoryMissingAtProviderError } = await import(
      "../../../adapters/vcs/repository-profile-source.js"
    );
    mocks.loadProfile.mockRejectedValue(
      new RepositoryMissingAtProviderError("github", "acme/api"),
    );

    const res = await post(suggestPost, { repositoryId });

    expect(res.status).toBe(404);
    expect((await res.json()).statusMessage).toBe("repository_missing_at_provider");
    const rows = await listRepositorySuggestions(db, repositoryId);
    expect(rows[0]).toMatchObject({ outcome: "missing", tokensInput: null });
  });

  it("answers 429 with the wait once the repository has had its hour's worth", async () => {
    for (let index = 0; index < REPOSITORY_SUGGESTION_RATE_LIMIT; index += 1) {
      await insertRepositorySuggestion(db, {
        repositoryId,
        actorId: "user_admin",
        actorLabel: "Admin",
        model: "claude-haiku-4-5",
        outcome: "proposed",
        usage: null,
      });
    }

    const res = await post(suggestPost, { repositoryId });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("suggestion_rate_limited");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers.get("retry-after")).toBe(String(body.retryAfterSeconds));
    expect(mocks.generateProviderText).not.toHaveBeenCalled();
    expect(await listRepositorySuggestions(db, repositoryId)).toHaveLength(
      REPOSITORY_SUGGESTION_RATE_LIMIT,
    );
  });

  it("gives a member 403 and never reaches the provider", async () => {
    state.sessionUserId = "user_member";

    const res = await post(suggestPost, { repositoryId });

    expect(res.status).toBe(403);
    expect(mocks.generateProviderText).not.toHaveBeenCalled();
    expect(await listRepositorySuggestions(db, repositoryId)).toEqual([]);
  });

  it("answers 404 for a repository the catalog has never heard of", async () => {
    const res = await post(suggestPost, { repositoryId: repositoryId + 99 });
    expect(res.status).toBe(404);
    expect(mocks.generateProviderText).not.toHaveBeenCalled();
  });
});
