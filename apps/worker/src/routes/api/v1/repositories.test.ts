import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_member",
  providers: [{ kind: "github" }] as Array<{ kind: "github" | "gitlab" }>,
  listing: vi.fn(),
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
}));

vi.mock("../../../../env.js", () => ({
  env: state.env,
  getConfiguredVcsProviders: () => state.providers,
}));
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
vi.mock("../../../adapters/vcs/repository-directory.js", () => ({
  listRepositoriesAcrossProviders: state.listing,
}));

const repositoriesGet = (await import("./repositories.get.js")).default;
const { resetRepositoriesCacheForTests } = await import("./repositories.get.js");

const REPO = {
  provider: "github",
  repoPath: "acme/web",
  name: "web",
  owner: "acme",
  defaultBranch: "main",
  description: "",
  webUrl: "https://github.com/acme/web",
  topics: [],
  archived: false,
  private: true,
};

function handlerFor(route: any) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

let db: Db;

beforeEach(async () => {
  vi.clearAllMocks();
  resetRepositoriesCacheForTests();
  state.providers = [{ kind: "github" }];
  state.listing.mockResolvedValue({ repositories: [REPO], failures: [] });
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    { id: "user_member", name: "Member", email: "member@example.com", emailVerified: true },
  ]);
  await db.insert(member).values([
    { id: "member_member", organizationId: "org_aiw", userId: "user_member", role: "member" },
  ]);
});

describe("GET /api/v1/repositories", () => {
  it("maps directory metadata to picker options (members allowed)", async () => {
    const res = await handlerFor(repositoriesGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repositories: [
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
      providers: [
        { provider: "github", status: "ready" },
        { provider: "gitlab", status: "not_connected" },
      ],
    });
  });

  it("serves the second request from cache", async () => {
    const handler = handlerFor(repositoriesGet);
    await handler(new Request("http://worker.test/"));
    await handler(new Request("http://worker.test/"));
    expect(state.listing).toHaveBeenCalledTimes(1);
  });

  it("keeps a surviving catalog and reports a configured provider failure", async () => {
    state.providers = [{ kind: "github" }, { kind: "gitlab" }];
    state.listing.mockResolvedValue({
      repositories: [REPO],
      failures: [
        {
          provider: "gitlab",
          message: "GitLab projects list failed: 401 Unauthorized",
          error: new Error("secret provider detail"),
        },
      ],
    });

    const res = await handlerFor(repositoriesGet)(
      new Request("http://worker.test/"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repositories: [
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
      providers: [
        { provider: "github", status: "ready" },
        {
          provider: "gitlab",
          status: "error",
          error: "GitLab projects list failed: 401 Unauthorized",
        },
      ],
    });
  });
});
