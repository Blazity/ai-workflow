import { describe, expect, it } from "vitest";
import { parsePostPrGateConfig } from "./config.js";

const valid = {
  postPrGate: {
    runOn: { botPrsOnly: true, draftPrs: false, baseBranches: [] },
    steps: [
      { uses: "pr-title-format", onFailure: "continue" },
    ],
  },
};

describe("parsePostPrGateConfig", () => {
  it("accepts a minimal valid config", () => {
    const parsed = parsePostPrGateConfig(valid);
    expect(parsed.postPrGate.steps).toHaveLength(1);
  });

  it("rejects unknown step names", () => {
    expect(() =>
      parsePostPrGateConfig({
        ...valid,
        postPrGate: {
          ...valid.postPrGate,
          steps: [{ uses: "does-not-exist", onFailure: "continue" }],
        },
      }),
    ).toThrow(/unknown post-pr-gate step/);
  });

  it("rejects invalid onFailure values", () => {
    expect(() =>
      parsePostPrGateConfig({
        ...valid,
        postPrGate: {
          ...valid.postPrGate,
          steps: [{ uses: "pr-title-format", onFailure: "move_to_backlog" }],
        },
      }),
    ).toThrow();
  });

  it("rejects unknown top-level keys", () => {
    expect(() => parsePostPrGateConfig({ ...valid, extra: 1 })).toThrow();
  });

  it("rejects missing runOn fields", () => {
    expect(() =>
      parsePostPrGateConfig({
        postPrGate: {
          runOn: { botPrsOnly: true },
          steps: [],
        },
      }),
    ).toThrow();
  });
});
