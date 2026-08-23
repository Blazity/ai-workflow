import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";
import { savePrePrCheckConfig } from "../../../pre-pr-checks/store.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin",
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
}));

vi.mock("../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: state.sessionUserId },
        session: { id: "session_test" },
      })),
    },
  },
}));

const checksGet = (await import("./pre-pr-checks.get.js")).default;
const checksPut = (await import("./pre-pr-checks.put.js")).default;
const restorePost = (await import("./pre-pr-checks/restore.post.js")).default;
const sessionGet = (await import("./session.get.js")).default;

const VALID_CONFIG = {
  repositories: [{ provider: "github" as const, repoPath: "acme/web", commands: ["pnpm test"] }],
};
const ACTOR = { actorRole: "admin" as const, actorId: "user_admin", actorLabel: "Admin" };

let db: Db;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerFor(route: any) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

function jsonRequest(method: string, body: unknown): Request {
  return new Request("http://worker.test/", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_admin";
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    { id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true },
    { id: "user_member", name: "Member", email: "member@example.com", emailVerified: true },
  ]);
  await db.insert(member).values([
    { id: "member_admin", organizationId: "org_aiw", userId: "user_admin", role: "admin" },
    { id: "member_member", organizationId: "org_aiw", userId: "user_member", role: "member" },
  ]);
});

describe("GET /api/v1/pre-pr-checks", () => {
  it("returns empty state when nothing was saved", async () => {
    const res = await handlerFor(checksGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ current: null, versions: [] });
  });

  it("returns current + versions newest first", async () => {
    await savePrePrCheckConfig(db, { ...ACTOR, config: { repositories: [] } });
    await savePrePrCheckConfig(db, { ...ACTOR, config: VALID_CONFIG });
    const res = await handlerFor(checksGet)(new Request("http://worker.test/"));
    const body = await res.json();
    expect(body.current.version).toBe(2);
    expect(body.current.config).toEqual(VALID_CONFIG);
    expect(typeof body.current.createdAt).toBe("string");
    expect(body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });
});

describe("PUT /api/v1/pre-pr-checks", () => {
  it("stores the submitted config verbatim rather than the normalized parse", async () => {
    const res = await handlerFor(checksPut)(jsonRequest("PUT", { config: VALID_CONFIG }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version.version).toBe(1);
    // Byte for byte what was submitted: no setup: [] filled in, no rewrite of
    // commands into groups.checks. The publication gate fingerprints the stored
    // configuration, so normalizing on save would invalidate every recorded
    // gate without an operator changing anything.
    expect(body.version.config).toEqual(VALID_CONFIG);
    expect(body.version.createdByLabel).toBe("Admin");
  });

  it("accepts the named-group shape and stores that verbatim too", async () => {
    const grouped = {
      repositories: [
        {
          provider: "github" as const,
          repoPath: "acme/web",
          env: ["NPM_TOKEN"],
          groups: {
            lint: { commands: ["pnpm lint"] },
            test: { commands: ["pnpm test"], extends: ["lint"] },
          },
          gateGroups: ["test"],
        },
      ],
      batchTimeoutMinutes: 45,
    };

    vi.stubEnv("PRE_PR_CHECKS_ALLOWED_ENV", "NPM_TOKEN");
    const res = await handlerFor(checksPut)(jsonRequest("PUT", { config: grouped }));

    expect(res.status).toBe(200);
    expect((await res.json()).version.config).toEqual(grouped);
  });

  it("rejects an env name the operator has not allowlisted, naming the name", async () => {
    // A save-time courtesy so the dashboard can say this while somebody is
    // typing, instead of a run failing an hour later. Batch start still
    // enforces it, so an allowlist shrunk after this save still fails loudly.
    vi.stubEnv("PRE_PR_CHECKS_ALLOWED_ENV", "NPM_TOKEN");

    const res = await handlerFor(checksPut)(
      jsonRequest("PUT", {
        config: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/web",
              env: ["NPM_TOKEN", "GITLAB_UNIFY_FRONTEND_TOKEN"],
              groups: { test: { commands: ["pnpm test"] } },
            },
          ],
        },
      }),
    );

    expect(res.status).toBe(400);
    const message = (await res.json()).statusMessage as string;
    expect(message).toContain("PRE_PR_CHECKS_ALLOWED_ENV");
    // The entry, not a flat list of names: a config of nine repositories told
    // only "GITLAB_UNIFY_FRONTEND_TOKEN is not allowlisted" has been told
    // nothing anyone can act on.
    expect(message).toContain("acme/web (GITLAB_UNIFY_FRONTEND_TOKEN)");
    // Both ways out, because only one of them is the author's to take.
    expect(message).toContain("remove the name");
    expect(message).toContain("redeploy");
    // The allowlisted one is not scolded, and no VALUE is ever echoed.
    expect(message).not.toContain("NPM_TOKEN,");
  });

  it("names only the repository entries that offend, not every entry", async () => {
    vi.stubEnv("PRE_PR_CHECKS_ALLOWED_ENV", "NPM_TOKEN");

    const res = await handlerFor(checksPut)(
      jsonRequest("PUT", {
        config: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/web",
              env: ["NPM_TOKEN"],
              groups: { test: { commands: ["pnpm test"] } },
            },
            {
              provider: "gitlab",
              repoPath: "acme/api",
              env: ["DATABASE_URL"],
              groups: { test: { commands: ["uv run pytest"] } },
            },
          ],
        },
      }),
    );

    expect(res.status).toBe(400);
    const message = (await res.json()).statusMessage as string;
    expect(message).toContain("acme/api (DATABASE_URL)");
    expect(message).not.toContain("acme/web");
  });

  it("rejects any env usage when nothing is allowlisted at all", async () => {
    vi.stubEnv("PRE_PR_CHECKS_ALLOWED_ENV", "");

    const res = await handlerFor(checksPut)(
      jsonRequest("PUT", {
        config: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/web",
              env: ["NPM_TOKEN"],
              groups: { test: { commands: ["pnpm test"] } },
            },
          ],
        },
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).statusMessage).toContain(
      "no environment variables are allowlisted",
    );
  });

  it("accepts an allowlisted env name that is currently unset", async () => {
    // Allowlisted but unset is a run-time failure, not a save-time one: a save
    // is a statement of intent, and refusing it would make configuring a
    // variable before deploying its value impossible.
    vi.stubEnv("PRE_PR_CHECKS_ALLOWED_ENV", "NPM_TOKEN");

    const res = await handlerFor(checksPut)(
      jsonRequest("PUT", {
        config: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/web",
              env: ["NPM_TOKEN"],
              groups: { test: { commands: ["pnpm test"] } },
            },
          ],
        },
      }),
    );

    expect(res.status).toBe(200);
  });

  it("rejects invalid config with 400 and named field", async () => {
    const res = await handlerFor(checksPut)(
      jsonRequest("PUT", {
        config: { repositories: [{ provider: "github", repoPath: "acme/web", commands: [] }] },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a group configuration the engine could not run", async () => {
    // Validation still happens, it simply does not rewrite what it validates.
    // A group extending a name no repository declares would expand to nothing.
    const res = await handlerFor(checksPut)(
      jsonRequest("PUT", {
        config: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/web",
              groups: { test: { commands: ["pnpm test"], extends: ["nope"] } },
            },
          ],
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects members with 403", async () => {
    state.sessionUserId = "user_member";
    const res = await handlerFor(checksPut)(jsonRequest("PUT", { config: VALID_CONFIG }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/pre-pr-checks/restore", () => {
  it("appends a copy of the requested version", async () => {
    await savePrePrCheckConfig(db, { ...ACTOR, config: VALID_CONFIG });
    await savePrePrCheckConfig(db, { ...ACTOR, config: { repositories: [] } });
    const res = await handlerFor(restorePost)(jsonRequest("POST", { version: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version.version).toBe(3);
    expect(body.version.config).toEqual(VALID_CONFIG);
    expect(body.version.restoredFromVersion).toBe(1);
  });

  it("404s on an unknown version", async () => {
    const res = await handlerFor(restorePost)(jsonRequest("POST", { version: 42 }));
    expect(res.status).toBe(404);
  });

  it("rejects members with 403", async () => {
    await savePrePrCheckConfig(db, { ...ACTOR, config: VALID_CONFIG });
    state.sessionUserId = "user_member";
    const res = await handlerFor(restorePost)(jsonRequest("POST", { version: 1 }));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/session", () => {
  it("reports canEditChecks per role", async () => {
    let res = await handlerFor(sessionGet)(new Request("http://worker.test/"));
    expect((await res.json()).canEditChecks).toBe(true);

    state.sessionUserId = "user_member";
    res = await handlerFor(sessionGet)(new Request("http://worker.test/"));
    expect((await res.json()).canEditChecks).toBe(false);
  });
});
