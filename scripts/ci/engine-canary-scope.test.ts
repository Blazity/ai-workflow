import assert from "node:assert/strict";
import test from "node:test";
import { engineCanaryScope } from "./engine-canary-scope.ts";

test("a worker engine step body is in scope", () => {
  assert.deepEqual(
    engineCanaryScope(["apps/worker/src/engine/steps/call-llm.ts"]),
    {
      run: true,
      matched: ["apps/worker/src/engine/steps/call-llm.ts"],
    },
  );
});

test("a docs-only change is out of scope", () => {
  assert.deepEqual(engineCanaryScope(["docs/architecture/gates.md"]), {
    run: false,
    matched: [],
  });
});

test("every file under packages is in scope", () => {
  assert.deepEqual(engineCanaryScope(["packages/x/README.md"]), {
    run: true,
    matched: ["packages/x/README.md"],
  });
});

test("a worker service change is out of scope", () => {
  assert.deepEqual(engineCanaryScope(["apps/worker/src/services/x.ts"]), {
    run: false,
    matched: [],
  });
});
