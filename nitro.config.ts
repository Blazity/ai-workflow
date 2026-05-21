import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineNitroConfig } from "nitropack/config";

export default defineNitroConfig({
  preset: "vercel",
  modules: [
    "workflow/nitro",
    // Ship pre-sandbox.yaml alongside the bundled function so the runtime can
    // read it from process.cwd() (Vercel /var/task). Nitro bundles JS only, so
    // root-level config files would otherwise be missing in prod. Registering
    // via a module avoids clobbering the Vercel preset's own `compiled` hook
    // (which writes the Build Output API config.json).
    (nitro) => {
      nitro.hooks.hook("compiled", async () => {
        await copyFile(
          resolve(nitro.options.rootDir, "pre-sandbox.yaml"),
          resolve(nitro.options.output.serverDir, "pre-sandbox.yaml"),
        );
      });
    },
  ],
  compatibilityDate: "2025-01-01",
  srcDir: "src",
  // Tests are co-located with source; exclude them from route scanning so a
  // file like `slack.post.test.ts` doesn't get matched as a POST route by the
  // file-based router.
  ignore: ["**/*.test.ts"],
});
