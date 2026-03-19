import { definePlugin } from "nitro";
import { createSandboxProvider } from "../sandbox/index.js";
import { appEnv } from "../env.js";

export default definePlugin(async () => {
  const provider =
    appEnv.SANDBOX_PROVIDER === "vercel"
      ? createSandboxProvider({ provider: "vercel", vercel: { vcpus: appEnv.VERCEL_SANDBOX_VCPUS } })
      : createSandboxProvider({ provider: "docker", docker: { image: appEnv.DOCKER_IMAGE, memoryLimitMb: appEnv.SANDBOX_MEMORY_MB } });

  await provider.cleanupOrphans();
});
