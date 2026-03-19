// packages/app/src/plugins/maintenance.ts
import { definePlugin } from "nitro";
import { start } from "workflow/api";
import { maintenanceLoop } from "../workflows/maintenance.js";
import { createLogger } from "@blazebot/shared";

const logger = createLogger();

export default definePlugin(async () => {
  // Start a single maintenance loop workflow.
  // The deterministic ID ensures only one instance runs.
  try {
    await start(maintenanceLoop, [], { id: "maintenance-loop" });
    logger.info("maintenance_loop_started");
  } catch (err) {
    // If workflow with this ID already exists, that's fine
    logger.info("maintenance_loop_already_running");
  }
});
