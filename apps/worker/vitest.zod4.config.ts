import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * The MCP tool catalog and contract, re-checked against the zod the deployed
 * bundle resolves.
 *
 * Nitro traces one `node_modules/zod` for the whole function and takes it from
 * `@workflow/core`, which is zod 4, while `pnpm-workspace.yaml` pins the
 * catalog at 3.25.76. The default `vitest run` therefore proves these schemas
 * under a version production does not run, which is how a one-argument
 * `z.record` reached production and answered 500 to every repository profile
 * save.
 *
 * This config names its files rather than extending `vitest.config.ts`: the
 * worker suite as a whole does NOT pass under zod 4 (its fixtures, its
 * better-auth surface and its error-message assertions all read zod 3), and
 * making it pass is a much larger piece of work than this gate. What runs here
 * is the set that builds schemas at import time and whose failure means the
 * deployed catalog is malformed rather than merely differently worded.
 *
 * `zod/v3` is aliased to `zod4/v3` rather than left alone, because the bundle
 * resolves that subpath inside the same zod 4 package; pointing it at the
 * workspace zod would test a resolution production does not perform.
 */
/**
 * An absolute path, because the alias is rewritten before resolution and the
 * importer may be a workspace package that does not declare `zod4` itself.
 */
const zod4 = fileURLToPath(new URL("./node_modules/zod4/", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@vercel/sandbox",
        replacement: fileURLToPath(
          new URL("./src/test-support/vercel-sandbox.ts", import.meta.url),
        ),
      },
      { find: /^zod$/u, replacement: `${zod4}index.js` },
      { find: /^zod\/(.*)$/u, replacement: `${zod4}$1` },
    ],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/mcp/tool-catalog*.test.ts", "src/mcp/contract*.test.ts"],
    hookTimeout: 30_000,
    testTimeout: 15_000,
  },
});
