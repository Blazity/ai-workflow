/**
 * Runs package test suites against zod 4 instead of the workspace zod 3.
 *
 * Production does not run the zod the workspace pins. The worker bundle
 * resolves a single `node_modules/zod` traced from `@workflow/core`, which is
 * zod 4 today, while `pnpm-workspace.yaml` pins the catalog at 3.25.76. So
 * typecheck and the default test runs exercise zod 3 while the deployed
 * function exercises zod 4, and a schema written in the part of the API where
 * the two versions disagree passes every gate and then fails in production.
 *
 * A package's `test:zod4` script loads this hook and re-runs its test files with
 * `zod` resolved to its `zod4` alias dependency. Subpaths are carried over
 * (`zod/v3` becomes `zod4/v3`), and every other specifier is passed through.
 * The alias resolves from the importer so each package exercises the dependency
 * it declares rather than depending on this shared hook's directory.
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
    return nextResolve(aliased, context);
  },
});
