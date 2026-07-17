import { copyFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defineNitroConfig } from "nitropack/config";

async function findFuncDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.name.endsWith(".func")) {
        out.push(full);
        continue;
      }
      await walk(full);
    }
  }
  try {
    await walk(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return out;
}

export default defineNitroConfig({
  preset: "vercel",
  modules: [
    "workflow/nitro",
    // Ship YAML configs into every Vercel function bundle so runtime code can
    // read them from process.cwd() (= /var/task). Nitro bundles JS only, and
    // @workflow/nitro emits separate step/flow/webhook functions in addition
    // to __fallback.func — each gets its own /var/task, so the yaml must be
    // copied into all of them. Registering as a module (not a `hooks` field)
    // ensures the Vercel preset's own `compiled` hook still runs.
    (nitro) => {
      nitro.hooks.hook("compiled", async () => {
        // All YAML configs are optional: runtime code falls back to built-in
        // defaults when a file is absent, and pre-sandbox.yaml / post-pr-gate.yaml
        // are deprecated. Ship whichever ones are committed, so an absent file
        // never fails the build.
        const optionalYamlFiles = [
          "pre-sandbox.yaml",
          "post-pr-gate.yaml",
          "post-pr-gate.test.yaml",
        ];
        const funcDirs = await findFuncDirs(
          resolve(nitro.options.output.dir, "functions"),
        );
        const presentYamlFiles: string[] = [];
        for (const name of optionalYamlFiles) {
          try {
            await stat(resolve(nitro.options.rootDir, name));
            presentYamlFiles.push(name);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        }
        await Promise.all(
          funcDirs.flatMap((dir) =>
            presentYamlFiles.map((name) =>
              copyFile(resolve(nitro.options.rootDir, name), join(dir, name)),
            ),
          ),
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
