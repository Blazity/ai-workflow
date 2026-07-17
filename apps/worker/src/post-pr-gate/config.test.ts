import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../lib/logger.js", () => ({ logger: { warn } }));

const { loadPostPrGateConfig, parsePostPrGateConfig } = await import("./config.js");

const valid = {
  postPrGate: {
    runOn: { botPrsOnly: true, draftPrs: false, baseBranches: [] },
    steps: [
      { uses: "pr-title-format", onFailure: "continue" },
    ],
  },
};

const defaultConfig = {
  postPrGate: {
    runOn: { botPrsOnly: true, draftPrs: false, baseBranches: [] },
    steps: [{ uses: "code-hygiene", onFailure: "continue", timeoutMs: 180000 }],
  },
};

const tempDirs: string[] = [];

function writeTempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "post-pr-gate-config-"));
  tempDirs.push(dir);
  const filePath = join(dir, "post-pr-gate.yaml");
  writeFileSync(filePath, contents);
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

beforeEach(() => {
  warn.mockClear();
});

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

describe("loadPostPrGateConfig", () => {
  it("returns the built-in default when the config file is missing", () => {
    expect(loadPostPrGateConfig(join(tmpdir(), "missing-post-pr-gate.yaml"))).toEqual(
      defaultConfig,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when the file matches the built-in default", () => {
    const configPath = writeTempConfig(`
postPrGate:
  runOn:
    botPrsOnly: true
    draftPrs: false
    baseBranches: []
  steps:
    - uses: code-hygiene
      onFailure: continue
      timeoutMs: 180000
`);

    expect(loadPostPrGateConfig(configPath)).toEqual(defaultConfig);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once when the file differs from the built-in default", () => {
    const configPath = writeTempConfig(`
postPrGate:
  runOn:
    botPrsOnly: true
    draftPrs: false
    baseBranches: []
  steps:
    - uses: code-hygiene
      name: code-hygiene
      onFailure: continue
      timeoutMs: 180000
`);

    loadPostPrGateConfig(configPath);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.anything(), "post_pr_gate_yaml_deprecated");
  });
});
