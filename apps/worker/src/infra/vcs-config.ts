import { env } from "./runtime-env.js";

/**
 * Core's access to the process environment, and nothing about version control
 * any more.
 *
 * This module used to build a provider from `GITHUB_*` and hand it to a
 * factory. S10 moved GitLab out and S11 moved GitHub, so there is no built-in
 * provider left to describe: a repository's provider comes from the catalog row
 * and is resolved through the `vcs` capability
 * (`engine/support/vcs-runtime.ts`). The file keeps its name and its `env`
 * export because that is what several hundred modules and tests import it for.
 */
export { env };
export type { Env } from "./runtime-env.js";

/** A registry id, which is any string the registry knows. */
export type VcsProviderKind = string;
