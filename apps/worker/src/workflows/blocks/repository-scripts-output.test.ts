import { describe, expect, it } from "vitest";
import {
  asRepositoryScriptsOutput,
  countUncoveredGroups,
  repositoryScriptCoverageNotes,
  repositoryScriptsRefusalMessage,
} from "./repository-scripts-output.js";
import type { RepositoryScriptGroupCoverage } from "./repository-scripts-output.js";

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

function failure(overrides: Record<string, unknown> = {}) {
  return {
    repo: "github:acme/web",
    command: "pnpm test",
    exitCode: 1,
    output: "",
    phase: null,
    ...overrides,
  };
}

function refusal(overrides: Record<string, unknown>) {
  return repositoryScriptsRefusalMessage(
    asRepositoryScriptsOutput(
      output({ ok: false, outcome: "failed", allPassed: false, anyFailed: true, ...overrides }),
    )!,
  );
}

describe("repositoryScriptsRefusalMessage", () => {
  it("names a failing command with its exit code", () => {
    expect(refusal({ failures: [failure()] })).toBe(
      "Repository scripts failed, so publication was refused: github:acme/web: pnpm test (exit 1)",
    );
  });

  it("leads a budget stop with the budget class, and never prints its synthetic exit code", () => {
    // checksBudgetExhaustedFailure records command "(checks budget)" and exit
    // -1 because nothing ran. Refusing with "Repository scripts failed ...
    // (exit -1)" contradicted the same comment's CHECKS BUDGET SPENT heading
    // and read as a command that ran and returned -1.
    const message = refusal({
      failures: [
        failure({ command: "(checks budget)", exitCode: -1, phase: "budget" }),
      ],
    });

    expect(message).toBe(
      "CHECKS BUDGET SPENT, so publication was refused: github:acme/web: (checks budget) (checks budget spent)",
    );
    expect(message).not.toContain("exit -1");
  });

  it("leads a stopped batch with the abandoned class", () => {
    expect(
      refusal({ failures: [failure({ exitCode: -1, phase: "batch" })] }),
    ).toBe(
      "Repository scripts were stopped before finishing, so publication was refused: " +
        "github:acme/web: pnpm test (batch stopped)",
    );
  });

  it("leads a setup or workspace failure with the not-started class", () => {
    expect(
      refusal({ failures: [failure({ command: "uv sync", exitCode: 127, phase: "setup" })] }),
    ).toBe(
      "Repository scripts could not be started, so publication was refused: " +
        "github:acme/web: uv sync (setup failed)",
    );
    expect(
      refusal({ failures: [failure({ exitCode: -1, phase: "workspace" })] }),
    ).toContain("(workspace unavailable)");
  });

  it("names a timeout with how long the command actually ran", () => {
    expect(
      refusal({
        failures: [failure({ command: "pnpm e2e", exitCode: 124 })],
        results: [
          {
            repo: "github:acme/web",
            command: "pnpm e2e",
            group: "checks",
            exitCode: 124,
            durationMs: 1_800_000,
            timedOut: true,
          },
        ],
      }),
    ).toBe(
      "Repository scripts timed out, so publication was refused: " +
        "github:acme/web: pnpm e2e (timed out after 30 minutes)",
    );
  });

  it("keeps the timeout of one repository off an identical command in another", () => {
    // Two repositories can name the same command. Joining results to failures
    // on the command text alone reported the second one as timed out, with the
    // first one's duration, while the ticket comment called it a plain failure.
    const message = refusal({
      failures: [failure({ repo: "github:acme/api", command: "pnpm test", exitCode: 1 })],
      results: [
        {
          repo: "github:acme/web",
          command: "pnpm test",
          group: "checks",
          exitCode: 124,
          durationMs: 1_800_000,
          timedOut: true,
        },
      ],
    });

    expect(message).toBe(
      "Repository scripts failed, so publication was refused: github:acme/api: pnpm test (exit 1)",
    );
  });

  it("counts only the failures of the class that led", () => {
    // "; and 1 more" beside a budget stop sent an operator looking for a second
    // failing command that does not exist.
    expect(
      refusal({
        failures: [
          failure({ command: "pnpm lint" }),
          failure({ command: "pnpm test" }),
          failure({ command: "(checks budget)", exitCode: -1, phase: "budget" }),
        ],
      }),
    ).toContain("pnpm lint (exit 1); and 1 more");
  });

  it("keeps the verdict when the repository path spends the whole budget", () => {
    const repo = `github:acme/${"platform-services-".repeat(5)}api`;
    const message = refusal({
      failures: [
        failure({ repo, command: "pnpm --filter @acme/api test --runInBand", exitCode: 2 }),
      ],
    });

    expect(repo.length).toBeGreaterThan(90);
    expect(message!.length).toBeLessThanOrEqual(160);
    expect(message).toContain("(exit 2)");
    expect(message).toContain("Repository scripts failed, so publication was refused:");
  });

  it("returns null when there is no failure to name", () => {
    expect(refusal({ failures: [] })).toBeNull();
  });
});

describe("repositoryScriptCoverageNotes", () => {
  it("names the repositories a selected group was never entered in", () => {
    // The silent case: three repositories declare "test", the workspace held
    // one, and every aggregate the run publishes is true of that one alone.
    expect(
      repositoryScriptCoverageNotes([
        { group: "test", missing: [], skipped: ["github:acme/api", "github:acme/infra"] },
      ]),
    ).toEqual([
      'Selected group "test" was not entered in github:acme/api, github:acme/infra; ' +
        "those repositories were not part of this run.",
    ]);
  });

  it("keeps a single skipped repository singular", () => {
    expect(
      repositoryScriptCoverageNotes([
        { group: "test", missing: [], skipped: ["github:acme/api"] },
      ]),
    ).toEqual([
      'Selected group "test" was not entered in github:acme/api; that repository was ' +
        "not part of this run.",
    ]);
  });

  it("leads with the missing repositories, then the skipped ones", () => {
    expect(
      repositoryScriptCoverageNotes([
        { group: "docs", missing: [], skipped: ["github:acme/infra"] },
        { group: "lint", missing: ["github:acme/web"], skipped: [] },
      ]),
    ).toEqual([
      'Selected group "lint" is not declared by github:acme/web; it ran nothing there.',
      'Selected group "docs" was not entered in github:acme/infra; that repository ' +
        "was not part of this run.",
    ]);
  });

  it("caps both kinds together and counts only the groups left unnarrated", () => {
    // "c" is narrated by its own missing sentence, so the tail counts "d"
    // alone: a group an operator has already read about is not more.
    const notes = repositoryScriptCoverageNotes([
      { group: "a", missing: ["github:acme/web"], skipped: [] },
      { group: "b", missing: [], skipped: ["github:acme/infra"] },
      { group: "c", missing: ["github:acme/web"], skipped: ["github:acme/infra"] },
      { group: "d", missing: [], skipped: ["github:acme/infra"] },
    ]);

    expect(notes).toEqual([
      'Selected group "a" is not declared by github:acme/web; it ran nothing there.',
      'Selected group "c" is not declared by github:acme/web; it ran nothing there.',
      'Selected group "b" was not entered in github:acme/infra; that repository was ' +
        "not part of this run.",
      "And 1 more selected group ran nothing in at least one repository.",
    ]);
  });

  it("says nothing about a group that ran everywhere it was asked to", () => {
    expect(
      repositoryScriptCoverageNotes([{ group: "test", missing: [], skipped: [] }]),
    ).toEqual([]);
  });
});

describe("countUncoveredGroups", () => {
  it("counts a group no participating repository declares", () => {
    expect(countUncoveredGroups([{ missing: ["github:acme/web"] }])).toBe(1);
  });

  it("leaves out a group whose absentees were never part of the run", () => {
    // A repository the gate's change filter excluded is the normal case on an
    // incremental run, so counting it would make `uncoveredGroupCount equals 0`
    // false on almost every run and useless as a branch. The sentences still
    // name it; the branchable count deliberately does not.
    const skippedOnly: RepositoryScriptGroupCoverage = {
      group: "test",
      declaredIn: ["github:acme/web"],
      missing: [],
      skipped: ["github:acme/api", "github:acme/infra"],
    };

    expect(countUncoveredGroups([skippedOnly])).toBe(0);
    expect(repositoryScriptCoverageNotes([skippedOnly])).toHaveLength(1);
  });
});
