/**
 * The settings and repository access a test runs under.
 *
 * Built from the registry's own defaults rather than from a hand-written
 * object, so a fixture never encodes a second opinion about what a key means
 * and a key added to the registry needs no edit here. A test that is about a
 * setting overrides exactly the key it is about and nothing else.
 */
import {
  resolveSettingsSnapshot,
  type RunRepositoryAccess,
  type SettingsSnapshot,
} from "@shared/contracts";

/** Nothing stored and no environment: every key resolves to its registry default. */
const NO_ENVIRONMENT = { value: () => undefined, isSet: () => false };

export function testSettingsSnapshot(
  overrides: Partial<SettingsSnapshot> = {},
): SettingsSnapshot {
  return {
    ...resolveSettingsSnapshot(new Map(), NO_ENVIRONMENT).snapshot,
    ...overrides,
  };
}

/**
 * The repository access a case that is NOT about the catalog runs under: the
 * bridge, where every repository the installation exposes is reachable, which
 * is what a deployment that has never opened the Repositories page has.
 *
 * It lives here, in test support, and nowhere production code can reach it. The
 * value is fail-open, so a named constant in `engine/` would let a caller that
 * forgot to thread the run's real list silence the type error with it instead
 * of fixing it. A case that IS about the catalog writes its own
 * `{ activated: true, enabledKeys: [...] }`.
 */
export const TEST_BRIDGE_REPOSITORY_ACCESS: RunRepositoryAccess = {
  activated: false,
  enabledKeys: [],
};
