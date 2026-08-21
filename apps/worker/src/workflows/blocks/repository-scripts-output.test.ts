import { describe, expect, it } from "vitest";
import { asRepositoryScriptsOutput } from "./repository-scripts-output.js";

/** Every field the emitter writes, which is the shape the guard is written
 *  against. Production never publishes a subset of it. */
function output(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    outcome: "passed",
    allPassed: true,
    anyFailed: false,
    groupStatuses: [],
    results: [],
    failures: [],
    dirtied: [],
    setupFailed: false,
    summary: "Repository scripts passed (1 command).",
    ...overrides,
  };
}

describe("asRepositoryScriptsOutput", () => {
  it("recognises the output both script blocks publish", () => {
    expect(asRepositoryScriptsOutput(output())).toMatchObject({
      outcome: "passed",
      summary: "Repository scripts passed (1 command).",
    });
  });

  it("refuses an output missing any single field the emitter always writes", () => {
    // One guard, one field set. Three hand-rolled versions of this test had
    // already drifted apart: one required `summary`, one required `dirtied`,
    // one required `failures`, so the same step output was recognised by some
    // readers and not by others.
    for (const field of [
      "ok",
      "outcome",
      "allPassed",
      "anyFailed",
      "groupStatuses",
      "results",
      "failures",
      "dirtied",
      "setupFailed",
      "summary",
    ]) {
      const partial = output();
      delete (partial as Record<string, unknown>)[field];
      expect(asRepositoryScriptsOutput(partial), field).toBeNull();
    }
  });

  it("refuses another block's output, and anything that is not one", () => {
    expect(asRepositoryScriptsOutput({ status: "ok", sandboxId: "sbx-1" })).toBeNull();
    // The gate output of a checks block that carries outcome but nothing else.
    expect(asRepositoryScriptsOutput({ outcome: "passed", gate: null })).toBeNull();
    expect(asRepositoryScriptsOutput(undefined)).toBeNull();
    expect(asRepositoryScriptsOutput(null)).toBeNull();
    expect(asRepositoryScriptsOutput("passed")).toBeNull();
    expect(asRepositoryScriptsOutput([])).toBeNull();
  });

  it("tolerates the extra keys each block adds on top of the shared fields", () => {
    // run_pre_pr_checks adds fixCycles and gate; the runtime adds status.
    expect(
      asRepositoryScriptsOutput(
        output({
          status: "ok",
          fixCycles: 0,
          gate: { configurationVersion: 7, fingerprint: "a" },
        }),
      ),
    ).not.toBeNull();
  });
});
