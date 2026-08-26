import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "./cli.js";
import { validateRehearsalEvidence } from "./rehearsal.js";

const version = "2026.08.8";
const sourceCommit = "b".repeat(40);

function rehearsal(overrides: Record<string, unknown> = {}) {
  return {
    version,
    sourceCommit,
    runId: "wrun_01K5NRQ8ABCDEF",
    runUrl: "https://ai-workflow.blazity.com/runs/wrun_01K5NRQ8ABCDEF",
    repository: "Blazity/aiw-checks-fixture",
    checksDurationSec: 1180,
    outcome: "success",
    recordedAt: "2026-08-19T10:00:00Z",
    recordedBy: "someone@blazity.com",
    ...overrides,
  };
}

async function recordPath(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "artur-rehearsal-"));
  const file = path.join(directory, `${version}.json`);
  await writeFile(file, contents);
  return file;
}

test("accepts a rehearsal of the released commit whose checks outlived one invocation", async () => {
  const rehearsalPath = await recordPath(JSON.stringify(rehearsal()));
  const record = await validateRehearsalEvidence({ version, sourceCommit, rehearsalPath });
  assert.equal(record.runId, "wrun_01K5NRQ8ABCDEF");
  assert.equal(record.checksDurationSec, 1180);
});

test("accepts checks that last exactly the one-invocation limit", async () => {
  const rehearsalPath = await recordPath(JSON.stringify(rehearsal({ checksDurationSec: 300 })));
  await assert.doesNotReject(validateRehearsalEvidence({ version, sourceCommit, rehearsalPath }));
});

test("blocks a release with no recorded rehearsal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "artur-rehearsal-missing-"));
  await assert.rejects(
    validateRehearsalEvidence({
      version,
      sourceCommit,
      rehearsalPath: path.join(directory, `${version}.json`),
    }),
    /No rehearsal is recorded for 2026\.08\.8/,
  );
});

test("blocks a rehearsal record that is not valid JSON", async () => {
  const rehearsalPath = await recordPath("{ not json");
  await assert.rejects(
    validateRehearsalEvidence({ version, sourceCommit, rehearsalPath }),
    /is not valid JSON/,
  );
});

test("blocks a rehearsal record with a missing field", async () => {
  const { checksDurationSec: _omitted, ...withoutDuration } = rehearsal();
  const rehearsalPath = await recordPath(JSON.stringify(withoutDuration));
  await assert.rejects(
    validateRehearsalEvidence({ version, sourceCommit, rehearsalPath }),
    /does not match the required shape.*checksDurationSec/s,
  );
});

test("blocks a rehearsal record with a malformed commit, timestamp or URL", async () => {
  const rehearsalPath = await recordPath(
    JSON.stringify(
      rehearsal({ sourceCommit: "B".repeat(40), recordedAt: "19-08-2026", runUrl: "runs/1" }),
    ),
  );
  await assert.rejects(
    validateRehearsalEvidence({ version, sourceCommit, rehearsalPath }),
    /sourceCommit.*runUrl.*recordedAt/s,
  );
});

test("blocks a rehearsal of a different source commit", async () => {
  const rehearsalPath = await recordPath(
    JSON.stringify(rehearsal({ sourceCommit: "c".repeat(40) })),
  );
  await assert.rejects(
    validateRehearsalEvidence({ version, sourceCommit, rehearsalPath }),
    /ran at source commit cccc.*ships bbbb/s,
  );
});

test("blocks a rehearsal that did not end in success", async () => {
  const rehearsalPath = await recordPath(JSON.stringify(rehearsal({ outcome: "failed" })));
  await assert.rejects(
    validateRehearsalEvidence({ version, sourceCommit, rehearsalPath }),
    /ended with outcome "failed"/,
  );
});

test("blocks a rehearsal whose checks never crossed one invocation", async () => {
  const rehearsalPath = await recordPath(JSON.stringify(rehearsal({ checksDurationSec: 299 })));
  await assert.rejects(
    validateRehearsalEvidence({ version, sourceCommit, rehearsalPath }),
    /299 seconds, below the 300 second floor/,
  );
});

test("blocks a rehearsal whose checks were stubs", async () => {
  const rehearsalPath = await recordPath(JSON.stringify(rehearsal({ checksDurationSec: 12 })));
  await assert.rejects(
    validateRehearsalEvidence({ version, sourceCommit, rehearsalPath }),
    /12 seconds, below the 300 second floor/,
  );
});

test("validate-rehearsal CLI reads the recorded rehearsal for the released version", async () => {
  const rehearsalPath = await recordPath(JSON.stringify(rehearsal()));
  await assert.doesNotReject(
    runCli([
      "validate-rehearsal",
      "--version",
      version,
      "--source-commit",
      sourceCommit,
      "--rehearsal",
      rehearsalPath,
    ]),
  );
  await assert.rejects(
    runCli(["validate-rehearsal", "--version", version, "--rehearsal", rehearsalPath]),
    /Missing required argument: --source-commit/,
  );
});
