import { describe, expect, it, vi } from "vitest";
import type { WorkflowDefinitionV1 } from "@shared/contracts";
import { resolveHarnessRuntimesWithLoader } from "./harness-profile-runtime.js";

describe("V1 Harness Profile compatibility resolution", () => {
  it("resolves virtual runtimes without loading an organization profile", async () => {
    const definition: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      nodes: [
        {
          id: "planning",
          type: "planning_agent",
          name: "Planning agent",
          x: 0,
          y: 0,
          params: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          inputs: {},
        },
      ],
      edges: [],
    };
    const load = vi.fn(async () => {
      throw new Error("V1 must not perform a dashboard organization lookup");
    });

    const runtimes = await resolveHarnessRuntimesWithLoader(
      definition,
      "claude",
      load,
    );

    expect(load).not.toHaveBeenCalled();
    expect(runtimes.planning).toMatchObject({
      legacyDynamicSkills: true,
      manifest: {
        profileId: "virtual-v1-codex",
        slug: "virtual-v1-codex",
        model: { id: "gpt-5-codex", options: {} },
      },
      cliSpec: {
        kind: "codex",
        version: "0.144.6",
        protocol: "codex-jsonl-0.144.6",
      },
    });
    expect(JSON.parse(JSON.stringify(runtimes.planning))).toEqual(
      runtimes.planning,
    );
  });
});
