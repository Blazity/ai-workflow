import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadPreSandboxConfig, parsePreSandboxConfig } from "./config.js";

const tempDirs: string[] = [];

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    preSandbox: {
      runOn: {
        newTicket: true,
        existingPr: true,
        mergeConflict: true,
      },
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

describe("pre-sandbox config", () => {
  it("loads the minimal valid YAML config", () => {
    const configPath = writeTempConfig(`
preSandbox:
  runOn:
    newTicket: true
    existingPr: true
    mergeConflict: true
  steps: []
`);

    expect(loadPreSandboxConfig(configPath)).toEqual(validConfig());
  });

  it("fails when the config file is missing", () => {
    expect(() => loadPreSandboxConfig(join(tmpdir(), "missing-pre-sandbox.yaml"))).toThrow(
      /Missing pre-sandbox config/,
    );
  });

  it("rejects a config without the required root key", () => {
    expect(() => parsePreSandboxConfig({ runOn: {}, steps: [] })).toThrow(/preSandbox/);
  });

  it("rejects missing runOn booleans", () => {
    expect(() =>
      parsePreSandboxConfig(
        validConfig({
          runOn: {
            newTicket: true,
            existingPr: true,
          },
        }),
      ),
    ).toThrow(/preSandbox\.runOn\.mergeConflict/);
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
