import assert from "node:assert/strict";
import test from "node:test";

import { previewHarnessCapabilities } from "./capabilities";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  type HarnessProfileManifestV1,
} from "@shared/contracts";

function manifest(
  overrides: Partial<HarnessProfileManifestV1> = {},
): HarnessProfileManifestV1 {
  return {
    ...structuredClone(
      BUILTIN_HARNESS_PROFILE_MANIFESTS[
        BUILTIN_HARNESS_PROFILE_IDS.codex
      ],
    ),
    ...overrides,
  };
}

test("generic scratch agents report their isolated file and git tools", () => {
  const capabilities = previewHarnessCapabilities({
    nodeType: "generic_agent",
    workspaceMode: "none",
    manifest: manifest({
      tools: ["filesystem", "shell", "git"],
      subagents: { enabled: true, maxConcurrent: 3 },
    }),
  });
  assert.deepEqual(capabilities.tools, ["filesystem", "git", "shell"]);
  assert.deepEqual(capabilities.clippedTools, []);
  assert.deepEqual(capabilities.subagents, {
    requested: true,
    enabled: false,
    maxConcurrent: 0,
    clipped: true,
  });
});

test("implementation agents keep catalog tools while current adapters clip subagents", () => {
  const capabilities = previewHarnessCapabilities({
    nodeType: "implementation_agent",
    manifest: manifest({
      tools: ["git", "shell", "filesystem"],
      subagents: { enabled: true, maxConcurrent: 2 },
    }),
  });
  assert.deepEqual(capabilities.tools, ["filesystem", "git", "shell"]);
  assert.deepEqual(capabilities.clippedTools, []);
  assert.equal(capabilities.subagents.enabled, false);
  assert.equal(capabilities.subagents.maxConcurrent, 0);
  assert.equal(capabilities.subagents.clipped, true);
});
