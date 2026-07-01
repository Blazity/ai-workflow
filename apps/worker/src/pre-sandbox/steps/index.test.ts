import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repoSelectionStep: vi.fn(),
}));

vi.mock("./repo-selection.js", () => ({
  repoSelectionStep: mocks.repoSelectionStep,
}));

import { preSandboxStepRegistry } from "./index.js";

describe("preSandboxStepRegistry", () => {
  it("registers repository selection", () => {
    expect(preSandboxStepRegistry["repo-selection"]).toBe(mocks.repoSelectionStep);
  });
});
