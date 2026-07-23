import { describe, expect, it } from "vitest";
import { restoreCheckpointValueSandboxReferences } from "./checkpoint.js";

describe("restoreCheckpointValueSandboxReferences", () => {
  it("remaps structured workspace identities throughout a v2 checkpoint", () => {
    const checkpoint = {
      version: 1,
      scopes: {
        root: {
          outputs: {
            prepare: {
              status: "ready",
              sandboxId: "sandbox-before",
              workspaceId: "sandbox-before",
              workspace: { id: "sandbox-before" },
              note: "Restore sandbox-before after clarification.",
              unrelated: { id: "sandbox-before" },
            },
          },
        },
      },
    };

    expect(
      restoreCheckpointValueSandboxReferences(
        checkpoint,
        "sandbox-before",
        "sandbox-after",
      ),
    ).toEqual({
      version: 1,
      scopes: {
        root: {
          outputs: {
            prepare: {
              status: "ready",
              sandboxId: "sandbox-after",
              workspaceId: "sandbox-after",
              workspace: { id: "sandbox-after" },
              note: "Restore sandbox-before after clarification.",
              unrelated: { id: "sandbox-before" },
            },
          },
        },
      },
    });
    expect(checkpoint.scopes.root.outputs.prepare.sandboxId).toBe(
      "sandbox-before",
    );
  });
});
