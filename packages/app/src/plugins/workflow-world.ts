// packages/app/src/plugins/workflow-world.ts
import { definePlugin } from "nitro";

export default definePlugin(async () => {
  // Skip in serverless — only run inside the long-lived sandbox
  if (process.env.SERVERLESS) return;

  const { getWorld } = await import("workflow/runtime");
  await getWorld().start?.();
});
