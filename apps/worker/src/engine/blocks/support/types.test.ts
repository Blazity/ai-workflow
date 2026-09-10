import { describe, expect, it } from "vitest";
import {
  agentArtifactPhase,
  buildV2AgentArtifactKeys,
  sanitizeBlockId,
} from "./types.js";

describe("v2 agent artifact identity", () => {
  it("assigns distinct deterministic keys when valid node ids sanitize alike", () => {
    const nodes = [{ id: "Blk_One" }, { id: "blk-one" }];
    const keys = buildV2AgentArtifactKeys(nodes);

    expect(sanitizeBlockId(nodes[0]!.id)).toBe(sanitizeBlockId(nodes[1]!.id));
    expect(keys.get("Blk_One")).toBe("1");
    expect(keys.get("blk-one")).toBe("2");
    expect(
      agentArtifactPhase("research", {
        agentArtifactKey: keys.get("Blk_One")!,
        attempt: 1,
      }),
    ).toBe("research-v2-1-a1");
    expect(
      agentArtifactPhase("research", {
        agentArtifactKey: keys.get("blk-one")!,
        attempt: 1,
      }),
    ).toBe("research-v2-2-a1");
  });

  it("preserves legacy phase names when no v2 identity is supplied", () => {
    expect(agentArtifactPhase("research")).toBe("research");
    expect(agentArtifactPhase("fix-fix-block-", { attempt: 2 })).toBe(
      "fix-fix-block-",
    );
  });
});
