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

test("a worker service change is out of scope", () => {
  assert.deepEqual(engineCanaryScope(["apps/worker/src/services/x.ts"]), {
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
