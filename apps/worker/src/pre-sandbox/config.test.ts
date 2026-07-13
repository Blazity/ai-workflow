import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../lib/logger.js", () => ({ logger: { warn } }));

const { loadPreSandboxConfig, parsePreSandboxConfig } = await import("./config.js");

const tempDirs: string[] = [];

const defaultConfig = {
  preSandbox: {
    steps: [{ uses: "repo-selection", onFailure: "fail", timeoutMs: 60000 }],
  },
};

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    preSandbox: {
      steps: [],
      ...overrides,
    },
  };
}

function writeTempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pre-sandbox-config-"));
  tempDirs.push(dir);
  const filePath = join(dir, "pre-sandbox.yaml");
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

describe("pre-sandbox config", () => {
  it("loads the minimal valid YAML config", () => {
    const configPath = writeTempConfig(`
preSandbox:
  steps: []
`);

    expect(loadPreSandboxConfig(configPath)).toEqual(validConfig());
  });

  it("returns the built-in default when the config file is missing", () => {
    expect(loadPreSandboxConfig(join(tmpdir(), "missing-pre-sandbox.yaml"))).toEqual(defaultConfig);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when the file matches the built-in default", () => {
    const configPath = writeTempConfig(`
preSandbox:
  steps:
    - uses: repo-selection
      onFailure: fail
      timeoutMs: 60000
`);

    expect(loadPreSandboxConfig(configPath)).toEqual(defaultConfig);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once when the file differs from the built-in default", () => {
    const configPath = writeTempConfig(`
preSandbox:
  steps:
    - uses: repo-selection
      name: Select repositories
      onFailure: fail
      timeoutMs: 60000
`);

    loadPreSandboxConfig(configPath);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.anything(), "pre_sandbox_yaml_deprecated");
  });

  it("rejects a config without the required root key", () => {
    expect(() => parsePreSandboxConfig({ runOn: {}, steps: [] })).toThrow(/preSandbox/);
  });

  it("rejects a non-array steps value", () => {
    expect(() => parsePreSandboxConfig(validConfig({ steps: {} }))).toThrow(/preSandbox\.steps/);
  });

  it("rejects an unknown registered step id", () => {
    expect(() =>
      parsePreSandboxConfig(
        validConfig({
          steps: [
            {
              uses: "unknown-step",
              onFailure: "fail",
            },
          ],
        }),
      ),
    ).toThrow(/unknown pre-sandbox step "unknown-step"/);
  });

  it.each([
    ["non-positive timeout", { timeoutMs: 0 }, /preSandbox\.steps\.0\.timeoutMs/],
    ["invalid onFailure", { onFailure: "retry" }, /preSandbox\.steps\.0\.onFailure/],
    ["empty name", { name: "   " }, /preSandbox\.steps\.0\.name/],
  ])("rejects %s", (_name, override, expectedError) => {
    expect(() =>
      parsePreSandboxConfig(
        validConfig({
          steps: [
            {
              uses: "some-step",
              onFailure: "fail",
              ...override,
            },
          ],
        }),
      ),
    ).toThrow(expectedError);
  });
});
