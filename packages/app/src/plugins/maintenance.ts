import { definePlugin } from "nitro";
import { start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { maintenanceLoop } from "../workflows/maintenance.js";
import { createLogger } from "@blazebot/shared";

const logger = createLogger();

async function cancelStaleRuns() {
  const workflowName = (maintenanceLoop as unknown as { workflowId: string })
    .workflowId;
  const world = getWorld();
  const [running, pending] = await Promise.all([
    world.runs.list({ workflowName, status: "running", resolveData: "all" }),
    world.runs.list({ workflowName, status: "pending", resolveData: "all" }),
  ]);

  const staleRuns = [...running.data, ...pending.data];
  await Promise.all(
    staleRuns.map((run) =>
      world.events.create(run.runId, {
        eventType: "run_cancelled",
        specVersion: run.specVersion ?? 1,
      }),
    ),
  );
  if (staleRuns.length > 0) {
    logger.info({ count: staleRuns.length }, "maintenance_loop_cancelled_stale");
  }
}

export default definePlugin(async () => {
  await cancelStaleRuns();
  await start(maintenanceLoop, []);
  logger.info("maintenance_loop_started");
});
