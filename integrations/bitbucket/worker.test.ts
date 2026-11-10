/**
 * The connection test and the health checks against a Bitbucket that is a
 * function. The statuses Bitbucket answers a refused token with (401, 403,
 * 404) are its documented ones for this listing; it documents no 5xx, so the
 * 503 below is a bare status, asserted only for how it is read.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fakeBitbucket, FAKE_TOKEN, json, on } from "./test-support";
import { runtime } from "./worker";

const LISTING = "/repositories/workspace_name?pagelen=1";

test("passes naming the workspace and what the token sees", async () => {
  const { ctx, sent } = fakeBitbucket([
    on("GET", LISTING, () => json(200, { size: 3, values: [{ full_name: "workspace_name/api" }] })),
  ]);
  assert.deepEqual(await runtime.testConnection(ctx), {
    ok: true,
    message: "Connected to Bitbucket workspace workspace_name; 3 repositories visible (workspace_name/api first).",
  });
  assert.equal(sent[0]!.headers.get("authorization"), `Bearer ${FAKE_TOKEN}`);
});

test("a token Bitbucket refuses for the workspace is a refusal of the values", async () => {
  for (const status of [401, 403, 404]) {
    const { ctx } = fakeBitbucket([on("GET", LISTING, () => json(status, { error: { message: "no" } }))]);
    const result = await runtime.testConnection(ctx);
    assert.equal(result.ok, false, String(status));
    assert.match(result.ok ? "" : result.reason, new RegExp(`workspace workspace_name \\(${status}\\)`, "u"));
  }
});

test("a token that sees no repository there is refused, since it reaches nothing a run could use", async () => {
  const { ctx } = fakeBitbucket([on("GET", LISTING, () => json(200, { size: 0, values: [] }))]);
  const result = await runtime.testConnection(ctx);
  assert.equal(result.ok, false);
});

test("Bitbucket failing says nothing about the values, and throws", async () => {
  const { ctx } = fakeBitbucket([on("GET", LISTING, () => json(503, {}))]);
  await assert.rejects(runtime.testConnection(ctx));
  const { ctx: odd } = fakeBitbucket([on("GET", LISTING, () => new Response("<html>", { status: 200 }))]);
  await assert.rejects(runtime.testConnection(odd), /did not answer the way the Bitbucket API does/u);
});

test("a workspace or token it can see is wrong is refused before anything is sent", async () => {
  const badWorkspace = fakeBitbucket([], { workspace: "https://bitbucket.org/acme" });
  const first = await runtime.testConnection(badWorkspace.ctx);
  assert.equal(first.ok === false && first.malformed, true);
  assert.equal(badWorkspace.sent.length, 0);
  const badToken = fakeBitbucket([], { token: "abc def" });
  const second = await runtime.testConnection(badToken.ctx);
  assert.equal(second.ok === false && second.malformed, true);
  assert.ok(!(second.ok === false && second.reason.includes("abc")));
  assert.equal(badToken.sent.length, 0);
});

test("health reads live, degraded or down from the same listing", async () => {
  const live = fakeBitbucket([on("GET", LISTING, () => json(200, { size: 2, values: [{ full_name: "w/a" }] }))]);
  assert.equal((await runtime.health.api(live.ctx)).status, "live");
  assert.equal((await runtime.health.repositories(live.ctx)).status, "live");
  const empty = fakeBitbucket([on("GET", LISTING, () => json(200, { size: 0, values: [] }))]);
  assert.equal((await runtime.health.repositories(empty.ctx)).status, "degraded");
  const refused = fakeBitbucket([on("GET", LISTING, () => json(401, {}))]);
  assert.equal((await runtime.health.api(refused.ctx)).status, "down");
  const failing = fakeBitbucket([on("GET", LISTING, () => json(503, {}))]);
  assert.equal((await runtime.health.api(failing.ctx)).status, "degraded");
});

test("the vcs capability is an adapter for the repository core asks for", async () => {
  const { ctx, sent } = fakeBitbucket([
    on("GET", "/repositories/workspace_name/api/refs/branches/main", () => json(200, { target: { hash: "a".repeat(40) } })),
  ]);
  const vcs = runtime.capabilities.vcs(ctx, { repoPath: "workspace_name/api", baseBranch: "main" });
  assert.equal(await vcs.getBranchSha("main"), "a".repeat(40));
  assert.equal(sent.length, 1);
});
