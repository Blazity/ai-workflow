import assert from "node:assert/strict";
import test from "node:test";
import { RepositoryMissingAtProviderError } from "@integrations/sdk";
import { bitbucketClient } from "./client";
import { createBitbucketProfileSource } from "./profile-source";
import { fakeBitbucket, FAKE_TOKEN, json, on } from "./test-support";

const REPO = "/repositories/workspace_name/api";
const COMMIT = "c".repeat(40);

function source(routes: Parameters<typeof fakeBitbucket>[0]) {
  const { ctx, sent } = fakeBitbucket(routes);
  return { profile: createBitbucketProfileSource(bitbucketClient({ http: ctx.http, token: FAKE_TOKEN }), "workspace_name/api"), sent };
}

const text = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/plain" } });

test("reads the README, the manifests and the Pipelines file at the main branch's commit", async () => {
  const { profile, sent } = source([
    on("GET", REPO, () => json(200, { description: "The API", language: "typescript", mainbranch: { name: "release/main" } })),
    on("GET", `${REPO}/refs/branches/release/main`, () => json(200, { target: { hash: COMMIT } })),
    on("GET", `${REPO}/src/${COMMIT}/?pagelen=100`, () =>
      json(200, {
        values: [
          { path: "README.md", type: "commit_file" },
          { path: "package.json", type: "commit_file" },
          { path: "pnpm-lock.yaml", type: "commit_file" },
          { path: "bitbucket-pipelines.yml", type: "commit_file" },
          { path: "src", type: "commit_directory" },
        ],
      }),
    ),
    on("GET", `${REPO}/src/${COMMIT}/README.md`, () => text("# API")),
    on("GET", `${REPO}/src/${COMMIT}/package.json`, () => text('{"name":"api"}')),
    on("GET", `${REPO}/src/${COMMIT}/bitbucket-pipelines.yml`, () => text("pipelines: {}")),
  ]);
  const bundle = await profile.loadProfile();
  assert.equal(bundle.provider, "bitbucket");
  assert.equal(bundle.defaultBranch, "release/main");
  assert.equal(bundle.description, "The API");
  assert.equal(bundle.readme, "# API");
  assert.deepEqual(bundle.manifests, [{ path: "package.json", content: '{"name":"api"}' }]);
  assert.deepEqual(bundle.lockfiles, ["pnpm-lock.yaml"]);
  assert.deepEqual(bundle.ciDefinitions, [{ path: "bitbucket-pipelines.yml", content: "pipelines: {}" }]);
  assert.deepEqual(bundle.languages, ["typescript"]);
  assert.deepEqual(bundle.truncated, []);
  assert.equal(sent.find((request) => request.path.endsWith("README.md"))!.headers.get("accept"), "*/*");
});

test("a repository that is gone is said so, not described as empty", async () => {
  const { profile } = source([on("GET", REPO, () => json(404, {}))]);
  await assert.rejects(profile.loadProfile(), RepositoryMissingAtProviderError);
});

test("a refused read fails the bundle rather than reading as a missing file", async () => {
  const { profile } = source([
    on("GET", REPO, () => json(200, { mainbranch: { name: "main" } })),
    on("GET", `${REPO}/refs/branches/main`, () => json(401, {})),
  ]);
  await assert.rejects(profile.loadProfile(), /401/u);
});
