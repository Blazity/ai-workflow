import { defineNitroPlugin } from "nitropack/runtime";

export default defineNitroPlugin(async () => {
  // Skip in serverless — Vercel handles the workflow runtime automatically
  if (process.env.VERCEL || process.env.SERVERLESS) return;

  // For local dev: boot the workflow world (requires WORKFLOW_POSTGRES_URL)
  try {
    const { getWorld } = await import("workflow/runtime");
    await getWorld().start?.();
  } catch (err) {
    console.warn("Workflow world not started:", (err as Error).message);
  }
});
