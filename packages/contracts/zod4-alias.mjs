/**
 * Runs this package's test suite against zod 4 instead of the workspace zod 3.
 *
 * Production does not run the zod the workspace pins. The worker bundle
 * resolves a single `node_modules/zod` traced from `@workflow/core`, which is
 * zod 4 today, while `pnpm-workspace.yaml` pins the catalog at 3.25.76. So
 * typecheck and the default test run exercise zod 3 while the deployed function
 * exercises zod 4, and a schema written in the part of the API where the two
 * versions disagree passes every gate and then throws on the first request that
 * reaches it. That is how a one-argument `z.record` reached production.
 *
 * `pnpm run test:zod4` re-runs the same test files with `zod` resolved to the
 * `zod4` alias dependency, so that disagreement fails here instead of there.
 *
 * The rewritten specifier is resolved against THIS file rather than against the
 * importer, because `zod4` is declared by this package alone while the importer
 * may be any file the suite pulls in. Subpaths are carried over (`zod/v3`
 * becomes `zod4/v3`), and every other specifier is passed straight through.
 *
 * `registerHooks` needs Node 22.15 or 23.5 and later; CI runs Node 24.
 */
import { registerHooks } from "node:module";

const ALIAS = "zod4",
  PACKAGE = "zod",
  SUBPATH_PREFIX = `${PACKAGE}/`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== PACKAGE && !specifier.startsWith(SUBPATH_PREFIX)) {
      return nextResolve(specifier, context);
    }
    const aliased =
      specifier === PACKAGE
        ? ALIAS
        : `${ALIAS}/${specifier.slice(SUBPATH_PREFIX.length)}`;
    return nextResolve(aliased, { ...context, parentURL: import.meta.url });
  },
});
