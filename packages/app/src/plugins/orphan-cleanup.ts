import { definePlugin } from "nitro";
import { createSandboxProvider } from "../sandbox/index.js";
import { appEnv } from "../env.js";

export default definePlugin(async () => {
  // Skip in serverless — only run inside the long-lived sandbox
  if (process.env.SERVERLESS) return;

  // TODO: Re-enable Docker provider when not deploying to Vercel
  const provider = await createSandboxProvider({
    provider: "vercel",
    vercel: { vcpus: appEnv.VERCEL_SANDBOX_VCPUS },
  });

  await provider.cleanupOrphans();
});
