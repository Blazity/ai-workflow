import assert from "node:assert/strict";
import test from "node:test";
import {
  handleHarnessProfileAction,
  handleHarnessProfileGet,
  handleHarnessProfilePatch,
  handleHarnessProfilesGet,
  handleHarnessProfilesPost,
  handleHarnessSkillAction,
} from "./handler";

const context = (id: string) => ({ params: Promise.resolve({ id }) });

test("profile collection and detail requests preserve paths, methods, and bodies", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const proxy = async (path: string, init?: RequestInit) => {
    calls.push({ path, init: init ?? {} });
    return Response.json({ ok: true });
  };
  await handleHarnessProfilesGet(
    new Request("https://dashboard.test/api/harness-profiles"),
    proxy,
  );
  await handleHarnessProfilesPost(
    new Request("https://dashboard.test/api/harness-profiles", {
      method: "POST",
      body: JSON.stringify({ slug: "review", draft: {} }),
    }),
    proxy,
  );
  await handleHarnessProfileGet(
    new Request("https://dashboard.test/api/harness-profiles/profile_1"),
    context("profile_1"),
    proxy,
  );
  await handleHarnessProfilePatch(
    new Request("https://dashboard.test/api/harness-profiles/profile_1", {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: 4, draft: {} }),
    }),
    context("profile_1"),
    proxy,
  );

  assert.deepEqual(
    calls.map(({ path, init }) => [path, init.method]),
    [
      ["/api/v1/harness-profiles", "GET"],
      ["/api/v1/harness-profiles", "POST"],
      ["/api/v1/harness-profiles/profile_1", "GET"],
      ["/api/v1/harness-profiles/profile_1", "PATCH"],
    ],
  );
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
    slug: "review",
    draft: {},
  });
  assert.deepEqual(JSON.parse(String(calls[3]?.init.body)), {
    expectedRevision: 4,
    draft: {},
  });
});

test("profile mutations and skill operations forward to the exact action routes", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const proxy = async (path: string, init?: RequestInit) => {
    calls.push({
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({ ok: true });
  };
  const mutation = (body: unknown) =>
    new Request("https://dashboard.test/api/action", {
      method: "POST",
      body: JSON.stringify(body),
    });

  await handleHarnessProfileAction(
    mutation({ expectedRevision: 2 }),
    context("profile_1"),
    "publish",
    proxy,
  );
  await handleHarnessProfileAction(
    mutation({ slug: "forked" }),
    context("profile_1"),
    "fork",
    proxy,
  );
  await handleHarnessProfileAction(
    mutation({ version: 1, expectedRevision: 2 }),
    context("profile_1"),
    "restore",
    proxy,
  );
  await handleHarnessProfileAction(
    mutation({ expectedRevision: 2, artifactHash: "sha256:old" }),
    context("profile_1"),
    "skills/refresh",
    proxy,
  );
  await handleHarnessSkillAction(
    mutation({ source: "openai/skills" }),
    "discover",
    proxy,
  );
  await handleHarnessSkillAction(
    mutation({
      source: {
        owner: "openai",
        repository: "skills",
        commitSha: "abc123",
      },
      paths: ["skills/docs"],
    }),
    "import",
    proxy,
  );

  assert.deepEqual(
    calls.map(({ path }) => path),
    [
      "/api/v1/harness-profiles/profile_1/publish",
      "/api/v1/harness-profiles/profile_1/fork",
      "/api/v1/harness-profiles/profile_1/restore",
      "/api/v1/harness-profiles/profile_1/skills/refresh",
      "/api/v1/harness-skills/discover",
      "/api/v1/harness-skills/import",
    ],
  );
  assert.deepEqual(calls[0]?.body, { expectedRevision: 2 });
  assert.deepEqual(calls[5]?.body, {
    source: {
      owner: "openai",
      repository: "skills",
      commitSha: "abc123",
    },
    paths: ["skills/docs"],
  });
});

test("invalid profile ids are rejected locally and timeouts remain JSON", async () => {
  let forwarded = false;
  const invalid = await handleHarnessProfileGet(
    new Request("https://dashboard.test/api/harness-profiles/escape"),
    context("../escape"),
    async () => {
      forwarded = true;
      return Response.json({});
    },
  );
  assert.equal(invalid.status, 404);
  assert.equal(forwarded, false);

  const timeout = await handleHarnessProfilesGet(
    new Request("https://dashboard.test/api/harness-profiles"),
    async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  );
  assert.equal(timeout.status, 504);
  assert.deepEqual(await timeout.json(), {
    error: "Worker request timed out",
  });
  assert.equal(timeout.headers.get("cache-control"), "no-store");
});

test("profile detail forwards only a valid exact pinned version", async () => {
  const paths: string[] = [];
  const proxy = async (path: string) => {
    paths.push(path);
    return Response.json({ ok: true });
  };
  await handleHarnessProfileGet(
    new Request(
      "https://dashboard.test/api/harness-profiles/profile_1?version=1&unsafe=1",
    ),
    context("profile_1"),
    proxy,
  );
  await handleHarnessProfileGet(
    new Request(
      "https://dashboard.test/api/harness-profiles/profile_1?version=invalid",
    ),
    context("profile_1"),
    proxy,
  );
  assert.deepEqual(paths, [
    "/api/v1/harness-profiles/profile_1?version=1",
    "/api/v1/harness-profiles/profile_1",
  ]);
});

test("profile collection forwards only the supported archived filter", async () => {
  const paths: string[] = [];
  const proxy = async (path: string) => {
    paths.push(path);
    return Response.json({ profiles: [], canManageProfiles: false });
  };
  await handleHarnessProfilesGet(
    new Request(
      "https://dashboard.test/api/harness-profiles?includeArchived=true&unsafe=1",
    ),
    proxy,
  );
  assert.deepEqual(paths, [
    "/api/v1/harness-profiles?includeArchived=1",
  ]);
});
