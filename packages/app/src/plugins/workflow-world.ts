// packages/app/src/plugins/workflow-world.ts
import { definePlugin } from "nitro";

export default definePlugin(async () => {
  const { getWorld } = await import("workflow/runtime");
  await getWorld().start?.();
});
