import { definePlugin } from "nitro";
import { createSandboxProvider } from "../sandbox/index.js";
import { appEnv } from "../env.js";

export default definePlugin(async () => {
  // TODO: Re-enable Docker provider when not deploying to Vercel
  const provider = await createSandboxProvider({
    provider: "vercel",
    vercel: { vcpus: appEnv.VERCEL_SANDBOX_VCPUS },
  });

  await provider.cleanupOrphans();
});
