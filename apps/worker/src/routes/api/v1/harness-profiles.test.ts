import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HarnessProfileDraftManifestV1,
  HarnessSkillImportRequest,
} from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
} from "@shared/contracts";
import type { Db } from "../../../db/client.js";
import { member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";
import type {
  GitHubSkillRepository,
  GitHubSkillTreeEntry,
} from "../../../harness-profiles/github-skills.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin" as string | null,
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
  repository: undefined as unknown,
}));

vi.mock("../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () =>
        state.sessionUserId
          ? {
              user: { id: state.sessionUserId },
              session: { id: "session_test" },
            }
          : null,
      ),
    },
  },
}));
vi.mock("../../../harness-profiles/configured-github-skills.js", () => ({
  createConfiguredGitHubSkillRepository: () => state.repository,
}));

const listGet = (await import("./harness-profiles.get.js")).default;
const createPost = (await import("./harness-profiles.post.js")).default;
const detailGet = (await import("./harness-profiles/[id].get.js")).default;
const detailPatch = (await import("./harness-profiles/[id].patch.js")).default;
const publishPost = (
  await import("./harness-profiles/[id]/publish.post.js")
).default;
const forkPost = (await import("./harness-profiles/[id]/fork.post.js")).default;
const restorePost = (
  await import("./harness-profiles/[id]/restore.post.js")
).default;
const archivePost = (
  await import("./harness-profiles/[id]/archive.post.js")
).default;
const refreshPost = (
  await import("./harness-profiles/[id]/skills/refresh.post.js")
).default;
const discoverPost = (
  await import("./harness-skills/discover.post.js")
).default;
const importPost = (await import("./harness-skills/import.post.js")).default;

const COMMIT_SHA = "1".repeat(40);
const TREE_SHA = "2".repeat(40);
const SKILL_SHA = "a".repeat(40);

class ApiSkillRepository implements GitHubSkillRepository {
  readonly skill = Buffer.from(
    "---\nname: review-rules\ndescription: Review rules\n---\n# Rules\n",
  );
  readonly entries: GitHubSkillTreeEntry[] = [
    {
      path: "skills/review-rules/SKILL.md",
      mode: "100644",
      type: "blob",
      sha: SKILL_SHA,
      size: this.skill.length,
    },
  ];

  async getDefaultBranch(): Promise<string> {
    return "main";
  }

  async resolveCommit(): Promise<{ commitSha: string; treeSha: string }> {
    return { commitSha: COMMIT_SHA, treeSha: TREE_SHA };
  }

  async getTree(): Promise<{
    entries: GitHubSkillTreeEntry[];
    truncated: boolean;
  }> {
    return { entries: this.entries, truncated: false };
  }

  async getBlob(): Promise<Buffer> {
    return Buffer.from(this.skill);
  }
}

let db: Db;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerFor(route: any) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

function paramHandler(
  method: "get" | "post" | "patch",
  pattern: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  route: any,
) {
  const app = createApp();
  const router = createRouter();
  router[method](pattern, route);
  app.use(router);
  return toWebHandler(app);
}

function jsonRequest(method: string, body: unknown, path = "/"): Request {
  return new Request(`http://worker.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function draft(): HarnessProfileDraftManifestV1 {
  const {
    profileId: _profileId,
    version: _version,
    slug: _slug,
    system: _system,
    ...value
  } = structuredClone(
    BUILTIN_HARNESS_PROFILE_MANIFESTS[BUILTIN_HARNESS_PROFILE_IDS.codex],
  );
  return value;
}

function expectNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_admin";
  state.repository = new ApiSkillRepository();
  db = await createTestDb();
  state.db = db;
  await db
    .insert(organization)
    .values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    {
      id: "user_admin",
      name: "Admin",
      email: "admin@example.com",
      emailVerified: true,
    },
    {
      id: "user_member",
      name: "Member",
      email: "member@example.com",
      emailVerified: true,
    },
  ]);
  await db.insert(member).values([
    {
      id: "member_admin",
      organizationId: "org_aiw",
      userId: "user_admin",
      role: "admin",
    },
    {
      id: "member_member",
      organizationId: "org_aiw",
      userId: "user_member",
      role: "member",
    },
  ]);
});

describe("Harness Profile API", () => {
  it("lets members list and read profiles while reserving mutations for owners/admins", async () => {
    let response = await handlerFor(listGet)(
      new Request("http://worker.test/"),
    );
    expect(response.status).toBe(200);
    expectNoStore(response);
    let body = await response.json();
    expect(body.profiles).toHaveLength(2);
    expect(body.canManageProfiles).toBe(true);

    const systemId = body.profiles[0].id as string;
    state.sessionUserId = "user_member";
    response = await handlerFor(listGet)(new Request("http://worker.test/"));
    expect(response.status).toBe(200);
    expectNoStore(response);
    expect((await response.json()).canManageProfiles).toBe(false);

    response = await paramHandler("get", "/profiles/:id", detailGet)(
      new Request(`http://worker.test/profiles/${systemId}`),
    );
    expect(response.status).toBe(200);
    expectNoStore(response);

    response = await handlerFor(createPost)(
      jsonRequest("POST", { slug: "forbidden", draft: draft() }),
    );
    expect(response.status).toBe(403);
    expectNoStore(response);
  });

  it("creates, edits, publishes, forks, restores, and archives with CAS", async () => {
    let response = await handlerFor(createPost)(
      jsonRequest("POST", { slug: "api-profile", draft: draft() }),
    );
    expect(response.status).toBe(200);
    expectNoStore(response);
    let body = await response.json();
    const profileId = body.profile.id as string;

    const edited = draft();
    edited.instructions = "Edited through the API";
    response = await paramHandler("patch", "/profiles/:id", detailPatch)(
      jsonRequest(
        "PATCH",
        { expectedRevision: 1, draft: edited },
        `/profiles/${profileId}`,
      ),
    );
    expect(response.status).toBe(200);
    expectNoStore(response);
    body = await response.json();
    expect(body.profile.draftRevision).toBe(2);

    response = await paramHandler("post", "/profiles/:id/publish", publishPost)(
      jsonRequest(
        "POST",
        { expectedRevision: 2 },
        `/profiles/${profileId}/publish`,
      ),
    );
    expect(response.status).toBe(200);
    expectNoStore(response);
    expect((await response.json()).version.version).toBe(1);

    response = await paramHandler("post", "/profiles/:id/fork", forkPost)(
      jsonRequest(
        "POST",
        { expectedRevision: 2, slug: "api-profile-fork" },
        `/profiles/${profileId}/fork`,
      ),
    );
    expect(response.status).toBe(200);
    expectNoStore(response);

    response = await paramHandler("post", "/profiles/:id/restore", restorePost)(
      jsonRequest(
        "POST",
        { expectedRevision: 2, version: 1 },
        `/profiles/${profileId}/restore`,
      ),
    );
    expect(response.status).toBe(200);
    expectNoStore(response);
    expect((await response.json()).profile.draftRevision).toBe(3);

    response = await paramHandler("post", "/profiles/:id/archive", archivePost)(
      jsonRequest(
        "POST",
        { expectedRevision: 3 },
        `/profiles/${profileId}/archive`,
      ),
    );
    expect(response.status).toBe(200);
    expectNoStore(response);
    expect((await response.json()).profile.archivedAt).not.toBeNull();
  });

  it("returns exact manifest validation details without caching the error", async () => {
    const invalid = draft() as unknown as Record<string, any>;
    invalid.harness.packageName = "arbitrary-command";
    const response = await handlerFor(createPost)(
      jsonRequest("POST", { slug: "invalid", draft: invalid }),
    );
    expect(response.status).toBe(400);
    expectNoStore(response);
    expect(JSON.stringify(await response.json())).toContain(
      "/harness/packageName",
    );
  });
});

describe("Harness Skill API", () => {
  it("discovers and imports exact-SHA skills for owners/admins without exposing bytes", async () => {
    let response = await handlerFor(discoverPost)(
      jsonRequest("POST", { source: "acme/skills/skills" }),
    );
    expect(response.status).toBe(200);
    expectNoStore(response);
    const discovery = await response.json();
    expect(discovery).toMatchObject({
      source: {
        owner: "acme",
        repository: "skills",
        commitSha: COMMIT_SHA,
      },
      skills: [{ name: "review-rules", path: "skills/review-rules" }],
    });

    const request: HarnessSkillImportRequest = {
      source: discovery.source,
      paths: [discovery.skills[0].path],
    };
    response = await handlerFor(importPost)(jsonRequest("POST", request));
    expect(response.status).toBe(200);
    expectNoStore(response);
    const imported = await response.json();
    expect(imported.artifacts[0].files[0]).toMatchObject({
      path: "SKILL.md",
      mode: 0o644,
    });
    expect(JSON.stringify(imported)).not.toContain("contentBase64");

    state.sessionUserId = "user_member";
    response = await handlerFor(discoverPost)(
      jsonRequest("POST", { source: "acme/skills" }),
    );
    expect(response.status).toBe(403);
    expectNoStore(response);
    response = await handlerFor(importPost)(jsonRequest("POST", request));
    expect(response.status).toBe(403);
    expectNoStore(response);
  });

  it("refreshes a referenced skill artifact through a CAS draft update", async () => {
    const importedResponse = await handlerFor(importPost)(
      jsonRequest("POST", {
        source: {
          owner: "acme",
          repository: "skills",
          commitSha: COMMIT_SHA,
        },
        paths: ["skills/review-rules"],
      }),
    );
    const imported = await importedResponse.json();
    const artifactHash = imported.artifacts[0].artifactHash as string;
    const withSkill = draft();
    withSkill.skills = [{ artifactHash, name: "review-rules" }];
    const createdResponse = await handlerFor(createPost)(
      jsonRequest("POST", { slug: "refresh-profile", draft: withSkill }),
    );
    const created = await createdResponse.json();

    const response = await paramHandler(
      "post",
      "/profiles/:id/skills/refresh",
      refreshPost,
    )(
      jsonRequest(
        "POST",
        { expectedRevision: 1, artifactHash },
        `/profiles/${created.profile.id}/skills/refresh`,
      ),
    );
    expect(response.status).toBe(200);
    expectNoStore(response);
    const refreshed = await response.json();
    expect(refreshed.profile.draftRevision).toBe(1);
    expect(refreshed.artifact.artifactHash).toBe(artifactHash);
  });
});
