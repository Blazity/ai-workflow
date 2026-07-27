import { eq } from "drizzle-orm";
import { getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { getDb } from "../src/db/client.js";
import { workflowRuns } from "../src/db/schema.js";

const EXPECTED_DEPLOYMENT = "dpl_DuNRZF1V4SRSxTE2D2UREtBSoe3m";
const RUN_IDS = [
  "wrun_01KYCYKGBHFQP40X6A00S68YHE",
  "wrun_01KYCYX2CA2DCYSD20H89B4VQ5",
  "wrun_01KYCZ81GTA63DXDE4T4K15FFR",
  "wrun_01KYCZK16XJWRSZ2JBRGRERW9R",
  "wrun_01KYCZY10SSZ9CDXHZR65ZW7VA",
  "wrun_01KYD09021YXW8BNT8SQ618B21",
] as const;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const CANCELLATION_CONFIRMATION_TIMEOUT_MS = 30_000;
const CANCELLATION_POLL_INTERVAL_MS = 500;

interface Inspection {
  runId: string;
  deploymentId: string | null;
  runStatus: string;
  firstStepName: string | null;
  firstStepStatus: string | null;
  firstStepAttempt: number | null;
  entryStarted: boolean;
  eligible: boolean;
}

async function inspect(runId: string): Promise<Inspection> {
  const world = getWorld();
  const [run, steps, rows] = await Promise.all([
    world.runs.get(runId, { resolveData: "none" }),
    world.steps.list({
      runId,
      resolveData: "none",
      pagination: { limit: 2 },
    }),
    getDb()
      .select({ entryStartedAt: workflowRuns.entryStartedAt })
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .limit(1),
  ]);
  const first = steps.data[0] ?? null;
  const deploymentId =
    "deploymentId" in run && typeof run.deploymentId === "string"
      ? run.deploymentId
      : null;
  const runStatus = String(run.status);
  const firstStepName =
    first && "stepName" in first && typeof first.stepName === "string"
      ? first.stepName
      : null;
  const firstStepStatus = first ? String(first.status) : null;
  const firstStepAttempt =
    first && typeof first.attempt === "number" ? first.attempt : null;
  const entryStarted = rows[0]?.entryStartedAt != null;
  return {
    runId,
    deploymentId,
    runStatus,
    firstStepName,
    firstStepStatus,
    firstStepAttempt,
    entryStarted,
    eligible:
      deploymentId === EXPECTED_DEPLOYMENT &&
      !TERMINAL.has(runStatus) &&
      firstStepName?.includes("bindWorkflowCandidateStep") === true &&
      firstStepStatus === "pending" &&
      firstStepAttempt === 0 &&
      !entryStarted,
  };
}

async function waitForTerminalStatus(runId: string): Promise<string> {
  const run = getRun(runId);
  const deadline = Date.now() + CANCELLATION_CONFIRMATION_TIMEOUT_MS;
  let status = await run.status;
  while (!TERMINAL.has(status) && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, CANCELLATION_POLL_INTERVAL_MS),
    );
    status = await run.status;
  }
  return status;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const inspections = await Promise.all(RUN_IDS.map(inspect));
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        expectedDeployment: EXPECTED_DEPLOYMENT,
        inspections,
      },
      null,
      2,
    )}\n`,
  );
  if (!apply) return;
  const ineligible = inspections.filter((item) => !item.eligible);
  if (ineligible.length > 0) {
    throw new Error(
      `Refusing cleanup: ${ineligible.map((item) => item.runId).join(", ")} failed the exact safety preflight.`,
    );
  }
  for (const item of inspections) {
    const rechecked = await inspect(item.runId);
    if (!rechecked.eligible) {
      throw new Error(
        `Refusing cleanup: ${item.runId} changed after preflight.`,
      );
    }
    await getRun(item.runId).cancel();
    const status = await waitForTerminalStatus(item.runId);
    if (!TERMINAL.has(status)) {
      throw new Error(
        `Cancellation of ${item.runId} was not confirmed (status: ${status}).`,
      );
    }
    process.stdout.write(`${item.runId}: ${status}\n`);
  }
}

await main();
