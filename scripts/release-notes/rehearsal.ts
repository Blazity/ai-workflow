import { readFile } from "node:fs/promises";

import { z } from "zod";

import { releaseVersionSchema } from "./types.js";

// Vercel gives each invocation 300 seconds. The client outage came from a check
// batch that outlived a single invocation, so a rehearsal that never crossed
// that boundary never touched the failure mode that reached the client. A run
// whose checks finished in 12 seconds because they were `echo ok` stubs proves
// the pipeline can open a pull request and proves nothing else. That is not
// hypothetical: the client configuration "worked" for weeks precisely because
// its heaviest repository had no check commands configured at all.
const MINIMUM_CHECKS_DURATION_SEC = 300;

const rehearsalRecordSchema = z
  .object({
    version: releaseVersionSchema,
    sourceCommit: z
      .string()
      .regex(/^[0-9a-f]{40}$/, "must be a 40 character lowercase Git SHA"),
    runId: z
      .string()
      .regex(/^wrun_[0-9A-Za-z]+$/, "must be a production run id such as wrun_01K5NRQ8"),
    runUrl: z.string().url("must be the absolute URL of the rehearsal run"),
    repository: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, "must be the owner/name of the rehearsed repository"),
    checksDurationSec: z
      .number()
      .int("must be a whole number of seconds")
      .nonnegative("must not be negative"),
    outcome: z.string().min(1, "must record how the rehearsal run ended"),
    recordedAt: z
      .string()
      .datetime("must be an ISO 8601 UTC timestamp such as 2026-08-19T10:00:00Z"),
    recordedBy: z.string().min(1, "must name the person who ran the rehearsal"),
  })
  .strict();

export type RehearsalRecord = z.infer<typeof rehearsalRecordSchema>;

export interface RehearsalInput {
  version: string;
  sourceCommit: string;
  rehearsalPath: string;
}

const HOW_TO_REHEARSE =
  "See docs/releases/artur/rehearsals/README.md for how to run a rehearsal and record it.";

export async function validateRehearsalEvidence(
  input: RehearsalInput,
): Promise<RehearsalRecord> {
  let raw: string;
  try {
    raw = await readFile(input.rehearsalPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(
      `No rehearsal is recorded for ${input.version}: ${input.rehearsalPath} does not exist. Run an end-to-end rehearsal on production against a repository with real pre-PR checks, at source commit ${input.sourceCommit}, and commit the record. ${HOW_TO_REHEARSE}`,
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Rehearsal record ${input.rehearsalPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}. Repair the file so it parses, then rerun the synchronization. ${HOW_TO_REHEARSE}`,
    );
  }
  const parsed = rehearsalRecordSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Rehearsal record ${input.rehearsalPath} does not match the required shape: ${issues}. Correct the listed fields and commit the record again. ${HOW_TO_REHEARSE}`,
    );
  }
  const record = parsed.data;
  if (record.version !== input.version) {
    throw new Error(
      `Rehearsal record ${input.rehearsalPath} states version ${record.version} but this release is ${input.version}. Record the rehearsal under the version being released.`,
    );
  }
  if (record.sourceCommit !== input.sourceCommit) {
    throw new Error(
      `Rehearsal for ${input.version} ran at source commit ${record.sourceCommit}, but the approved release ships ${input.sourceCommit}. A rehearsal of a different commit proves nothing: rehearse a deployment built from ${input.sourceCommit} and record that run.`,
    );
  }
  if (record.outcome !== "success") {
    throw new Error(
      `Rehearsal ${record.runId} for ${input.version} ended with outcome "${record.outcome}", not "success". Fix what broke, rehearse again until the run opens its pull request green, then record that run: ${record.runUrl}`,
    );
  }
  if (record.checksDurationSec < MINIMUM_CHECKS_DURATION_SEC) {
    throw new Error(
      `Rehearsal ${record.runId} for ${input.version} ran checks for ${record.checksDurationSec} seconds, below the ${MINIMUM_CHECKS_DURATION_SEC} second floor. Vercel allows 300 seconds per invocation and the client outage came from a check batch that outlived one invocation, so a shorter rehearsal proves nothing about that failure mode. Rehearse against a repository whose checks really run past 300 seconds (toolchain setup plus the long checks), not against stub commands.`,
    );
  }
  return record;
}
