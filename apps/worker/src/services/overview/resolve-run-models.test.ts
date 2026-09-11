import { describe, expect, it, vi } from "vitest";

const fetchEvidence = vi.hoisted(() => vi.fn());

vi.mock("../../db/repositories/runs.js", () => ({
  fetchConnectedRunModelEvidence: fetchEvidence,
}));

import { resolveRunModels } from "./resolve-run-models.js";

describe("resolveRunModels", () => {
  it("applies harness attribution above the persisted organization default", async () => {
    fetchEvidence.mockResolvedValueOnce(new Map([[
      "run-1",
      {
        model: "claude-opus-4-8",
        harnessManifests: [{ nodeId: "planning", manifest: { model: { id: "gpt-5.6-sol" } } }],
        blockStatuses: { planning: { status: "fail" } },
      },
    ]]));

    await expect(resolveRunModels(["run-1"])).resolves.toEqual(
      new Map([["run-1", "gpt-5.6-sol"]]),
    );
  });
});
