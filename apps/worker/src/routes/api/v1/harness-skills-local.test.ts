import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler } from "h3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessProfileDraftManifestV1 } from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
} from "@shared/contracts";
import type { Db } from "../../../db/client.js";
import {
  harnessSkillArtifacts,
  member,
  organization,
  user,
} from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin" as string | null,
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
}));

/**
 * A deployment with no GitHub App: asking for the provider config throws, which
 * is the exact condition the local routes exist to survive. Nothing here is
 * stubbed for the local path, so whatever it reaches for, it reaches for real.
 */
vi.mock("../../../../env.js", () => ({
  env: state.env,
  getVcsProviderConfig: () => {
    throw new Error("No VCS provider is configured");
  },
}));
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

const localGet = (await import("./harness-skills/local.get.js")).default;
const localPost = (await import("./harness-skills/local.post.js")).default;
const githubDiscoverPost = (await import("./harness-skills/discover.post.js"))
  .default;
const createPost = (await import("./harness-profiles.post.js")).default;
const refreshPost = (
  await import("./harness-profiles/[id]/skills/refresh.post.js")
).default;

let db: Db;
let workingDirectory: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerFor(route: any) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

function jsonRequest(method: string, body: unknown, path = "/"): Request {
  return new Request(`http://worker.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function paramHandler(
  pattern: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  route: any,
) {
  const app = createApp();
  const router = createRouter();
  router.post(pattern, route);
  app.use(router);
  return toWebHandler(app);
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

function writeSkill(name: string, description: string): void {
  const directory = join(workingDirectory, "skills", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_admin";
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
  // The reader resolves `skills/` against the process working directory, the
  // same way it finds the copy the build hook drops beside each function.
  workingDirectory = mkdtempSync(join(tmpdir(), "local-skills-api-"));
  vi.spyOn(process, "cwd").mockReturnValue(workingDirectory);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workingDirectory, { force: true, recursive: true });
});

describe("deployment-local skill API", () => {
  it("discovers and imports deployment skills while GitHub is unconfigured", async () => {
    writeSkill("review-rules", "Client-specific review rules.");

    const unconfigured = await handlerFor(githubDiscoverPost)(
      jsonRequest("POST", { source: "acme/skills" }),
    );
    expect(unconfigured.status).toBe(503);

    const discovery = await handlerFor(localGet)(
      new Request("http://worker.test/"),
    );
    expect(discovery.status).toBe(200);
    expect(discovery.headers.get("cache-control")).toBe("private, no-store");
    const listed = await discovery.json();
    expect(listed).toEqual({
      directoryPresent: true,
      skipped: [],
      skills: [
        {
          name: "review-rules",
          path: "review-rules",
          description: "Client-specific review rules.",
          artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });

    const imported = await handlerFor(localPost)(
      jsonRequest("POST", { skills: [listed.skills[0]] }),
    );
    expect(imported.status).toBe(200);
    expect((await imported.json()).artifacts).toMatchObject([
      { name: "review-rules", source: { path: "review-rules" } },
    ]);
    expect(await db.select().from(harnessSkillArtifacts)).toMatchObject([
      { sourceKind: "local", localPath: "review-rules", sourceOwner: null },
    ]);
  });

  it("repoints a pinned deployment skill at the redeployed content", async () => {
    writeSkill("review-rules", "Client-specific review rules.");
    const listed = await (
      await handlerFor(localGet)(new Request("http://worker.test/"))
    ).json();
    const imported = await (
      await handlerFor(localPost)(
        jsonRequest("POST", { skills: [listed.skills[0]] }),
      )
    ).json();
    const artifactHash = imported.artifacts[0].artifactHash as string;
    const withSkill = draft();
    withSkill.skills = [{ artifactHash, name: "review-rules" }];
    const created = await (
      await handlerFor(createPost)(
        jsonRequest("POST", { slug: "local-refresh", draft: withSkill }),
      )
    ).json();

    // The redeploy: same path, new bytes, and a pin that still points at the
    // old artifact until refresh mints a new one.
    writeSkill("review-rules", "Rules the client rewrote.");
    const response = await paramHandler(
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
    const refreshed = await response.json();
    expect(refreshed.artifact.artifactHash).not.toBe(artifactHash);
    expect(refreshed.artifact.description).toBe("Rules the client rewrote.");
    expect(refreshed.profile.draft.skills).toEqual([
      { artifactHash: refreshed.artifact.artifactHash, name: "review-rules" },
    ]);
  });

  it("reserves both routes for the roles that manage profiles", async () => {
    state.sessionUserId = "user_member";

    expect(
      (await handlerFor(localGet)(new Request("http://worker.test/"))).status,
    ).toBe(403);
    expect(
      (
        await handlerFor(localPost)(
          jsonRequest("POST", {
            skills: [{ path: "review-rules", artifactHash: "a".repeat(64) }],
          }),
        )
      ).status,
    ).toBe(403);
  });
});
