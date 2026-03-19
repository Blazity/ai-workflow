// packages/app/src/plugins/orphan-cleanup.ts
import { definePlugin } from "nitro";
import { cleanupOrphanContainers } from "../sandbox/manager.js";

export default definePlugin(async () => {
  await cleanupOrphanContainers();
});
