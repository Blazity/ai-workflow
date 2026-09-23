import assert from "node:assert/strict";
import test from "node:test";

import { areaOfPath, assignArea } from "./areas.ts";

test("paths map to the area a user would look in, narrow rules first", () => {
  assert.equal(areaOfPath("apps/dashboard/app/(cockpit)/runs/page.tsx"), "Dashboard");
  assert.equal(areaOfPath("apps/worker/src/engine/run-workflow.ts"), "Runs and workflows");
  assert.equal(areaOfPath("packages/workflow-graph/policies.ts"), "Runs and workflows");
  assert.equal(areaOfPath("integrations/jira/src/index.ts"), "Integrations");
  assert.equal(areaOfPath("apps/worker/src/adapters/github.ts"), "Integrations");
  assert.equal(areaOfPath("apps/worker/src/mcp/tools/runs.ts"), "MCP");
  assert.equal(areaOfPath("SETUP.md"), "Setup and operations");
  assert.equal(areaOfPath("apps/dashboard/app/(cockpit)/settings/page.tsx"), "Setup and operations");
  assert.equal(areaOfPath("apps/worker/src/services/settings/registry.ts"), "Setup and operations");
  assert.equal(areaOfPath("scripts/ci/verify-changed.ts"), "Other");
  assert.equal(areaOfPath("docs/adr/ADR-010-integrations.md"), "Other");
});

test("the scope of the commit that added the entry decides first", () => {
  assert.equal(
    assignArea({
      commitPaths: ["apps/worker/src/services/integrations/impact.ts", "apps/worker/src/engine/x.ts", "apps/worker/src/engine/y.ts", "apps/dashboard/lib/impact.ts"],
      commitSubject: "feat(dashboard): say which workflows and runs a connection change would stop",
      pullRequestPaths: ["integrations/jira/a.ts", "integrations/jira/b.ts"],
    }),
    "Dashboard",
  );
});

test("a scope that spans areas, like worker, falls through to the commit's paths", () => {
  assert.equal(
    assignArea({
      commitPaths: ["apps/worker/src/mcp/tools/a.ts", "apps/worker/src/mcp/tools/b.ts", "apps/worker/src/engine/c.ts"],
      commitSubject: "feat(worker): serve briefings over MCP",
    }),
    "MCP",
  );
});

test("the entry file, CHANGELOG.md and tests do not vote", () => {
  assert.equal(
    assignArea({
      commitPaths: [
        "changelog/unreleased/a.md",
        "apps/dashboard/components/a.test.tsx",
        "apps/dashboard/components/b.test.tsx",
        "apps/worker/src/engine/run.ts",
      ],
      commitSubject: "feat(worker): something",
    }),
    "Runs and workflows",
  );
});

test("an entry added in a commit of its own takes its area from the whole pull request", () => {
  assert.equal(
    assignArea({
      commitPaths: ["changelog/unreleased/integrations-screen-qa-fixes.md"],
      commitSubject: "docs(changelog): describe the integrations screen fixes from QA",
      pullRequestPaths: ["apps/dashboard/components/a.tsx", "apps/dashboard/components/b.tsx", "apps/worker/src/db/x.ts"],
    }),
    "Dashboard",
  );
});

test("an entry nothing places lands in Other", () => {
  assert.equal(assignArea({}), "Other");
  assert.equal(
    assignArea({ commitPaths: ["scripts/gates/lint.mjs", "docs/index.md"], commitSubject: "chore(ci): tidy" }),
    "Other",
  );
});

test("a tie goes to the area listed first", () => {
  assert.equal(
    assignArea({ commitPaths: ["integrations/slack/a.ts", "apps/dashboard/components/a.tsx"] }),
    "Dashboard",
  );
});
