import { definePlugin } from "nitro";
import { start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { maintenanceLoop } from "../workflows/maintenance.js";
import { createLogger } from "@blazebot/shared";

const logger = createLogger();

export default definePlugin(async () => {
  const workflowName = (maintenanceLoop as unknown as { workflowId: string })
    .workflowId;
  const world = getWorld();
  const [running, pending] = await Promise.all([
    world.runs.list({ workflowName, status: "running", resolveData: "none" }),
    world.runs.list({ workflowName, status: "pending", resolveData: "none" }),
  ]);

  if (running.data.length > 0 || pending.data.length > 0) {
    logger.info("maintenance_loop_already_running");
    return;
  }

  await start(maintenanceLoop, []);
  logger.info("maintenance_loop_started");
});
