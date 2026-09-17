import assert from "node:assert/strict";
import test from "node:test";
import { engineCanaryScope } from "./engine-canary-scope.ts";

test("a worker engine step body is in scope", () => {
  assert.deepEqual(
    engineCanaryScope(["apps/worker/src/engine/steps/call-llm.ts"]),
    {
      run: true,
      migrations: false,
      matched: ["apps/worker/src/engine/steps/call-llm.ts"],
    },
  );
});

test("a worker database file is in scope", () => {
  assert.deepEqual(engineCanaryScope(["apps/worker/src/db/repositories/runs.ts"]), {
    run: true,
    migrations: false,
    matched: ["apps/worker/src/db/repositories/runs.ts"],
  });
});

test("a worker database lookalike directory is out of scope", () => {
  assert.deepEqual(engineCanaryScope(["apps/worker/src/database/client.ts"]), {
    run: false,
    migrations: false,
    matched: [],
  });
});

test("a docs-only change is out of scope", () => {
  assert.deepEqual(engineCanaryScope(["docs/architecture/gates.md"]), {
    run: false,
    migrations: false,
    matched: [],
  });
});

test("every file under packages is in scope", () => {
  assert.deepEqual(engineCanaryScope(["packages/x/README.md"]), {
    run: true,
    migrations: false,
    matched: ["packages/x/README.md"],
  });
});

/**
 * Three directories out of apps/worker/src/services/ are listed and the rest of
 * that tree is not. The narrowness is the decision, so it is guarded from both
 * sides: these real sibling directories must stay out.
 */
test("a worker service change outside the three listed directories is out of scope", () => {
  assert.deepEqual(
    engineCanaryScope([
      "apps/worker/src/services/x.ts",
      "apps/worker/src/services/workflow-definitions/policy-operations.ts",
      "apps/worker/src/services/harness/profile-authoring.ts",
    ]),
    {
      run: false,
      migrations: false,
      matched: [],
    },
  );
});

test("the service directories the canary reads its evidence through are in scope", () => {
  const paths = [
    "apps/worker/src/services/system/deployment-identity.ts",
    "apps/worker/src/services/overview/sanitize-run-detail.ts",
  ];
  assert.deepEqual(engineCanaryScope(paths), {
    run: true,
    migrations: false,
    matched: paths,
  });
});

/**
 * Both are listed by directory, never by the file that holds the logic today.
 * A file path would answer "not in scope" the day somebody renames the file,
 * and that silent answer is the failure this list exists to prevent, so the
 * cover is asserted against names nobody has written yet.
 */
test("a renamed file inside those directories stays in scope", () => {
  const paths = [
    "apps/worker/src/services/system/renamed-after-this-test-was-written.ts",
    "apps/worker/src/services/overview/renamed-after-this-test-was-written.ts",
  ];
  assert.deepEqual(engineCanaryScope(paths), {
    run: true,
    migrations: false,
    matched: paths,
  });
});

test("the deployed surfaces the canary drives are in scope", () => {
  const paths = [
    "apps/worker/src/mcp/tool-catalog.ts",
    "apps/worker/src/routes/mcp.post.ts",
    "apps/worker/src/routes/.well-known/oauth-authorization-server/api/auth.get.ts",
    "apps/worker/src/sandbox/harness-runtime.ts",
    "apps/worker/src/harness-profiles/manifest.ts",
  ];
  assert.deepEqual(engineCanaryScope(paths), {
    run: true,
    migrations: false,
    matched: paths,
  });
});

test("an mcp lookalike directory is out of scope", () => {
  assert.deepEqual(engineCanaryScope(["apps/worker/src/mcp-dogfood/server.ts"]), {
    run: false,
    migrations: false,
    matched: [],
  });
});

/**
 * The two production outages this gate exists for arrived through a dependency,
 * not through worker source: the zod the deployed bundle resolves, and a
 * subpath import that answered ERR_MODULE_NOT_FOUND on Vercel alone. Neither
 * touches a source directory, so these three files are the only signal the
 * selection has for that class.
 */
test("the dependency inputs of the deployed bundle are in scope", () => {
  const paths = ["pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/worker/package.json"];
  assert.deepEqual(engineCanaryScope(paths), {
    run: true,
    migrations: false,
    matched: paths,
  });
});

test("another workspace manifest does not select the canary on its own", () => {
  assert.deepEqual(engineCanaryScope(["apps/dashboard/package.json"]), {
    run: false,
    migrations: false,
    matched: [],
  });
});

test("a worker migration is detected without selecting the pull request canary", () => {
  assert.deepEqual(engineCanaryScope(["apps/worker/drizzle/0066_example.sql"]), {
    run: false,
    migrations: true,
    matched: [],
  });
});

test("migration metadata is detected", () => {
  assert.deepEqual(
    engineCanaryScope(["apps/worker/drizzle/meta/_journal.json"]),
    {
      run: false,
      migrations: true,
      matched: [],
    },
  );
});

test("a migration lookalike directory is not detected", () => {
  assert.deepEqual(engineCanaryScope(["apps/worker/drizzle-old/0066.sql"]), {
    run: false,
    migrations: false,
    matched: [],
  });
});

test("a change to the canary itself or to the run lifecycle it drives is in scope", () => {
  const paths = [
    "apps/worker/src/services/run-lifecycle/cancel-run.ts",
    "apps/worker/e2e/harness-profiles/preview-canary.ts",
    "apps/worker/e2e/replay/preview-canary.ts",
    "scripts/ci/engine-canary-preflight.ts",
    ".github/workflows/ci.yml",
  ];
  assert.deepEqual(engineCanaryScope(paths), {
    run: true,
    migrations: false,
    matched: paths,
  });
});
