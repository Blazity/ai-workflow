import { defineNitroPlugin } from "nitropack/runtime";
import { assertNoRetiredEnvironmentVariables } from "../services/settings/retired-environment.js";

export default defineNitroPlugin(async () => {
  assertNoRetiredEnvironmentVariables(process.env);

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
