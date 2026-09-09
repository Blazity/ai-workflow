import { describe, expect, it } from "vitest";
import { GitHubAdapter } from "./github.js";
import { GitLabAdapter } from "./gitlab.js";
import * as vcs from "./types.js";
import type { VCSAdapter } from "./types.js";

/**
 * GitHub and GitLab are not interchangeable, and every place they differ is
 * supposed to be declared: either a capability interface with a runtime guard,
 * or an optional member on `VCSAdapter`. Nothing enforced that. A capability
 * added on the GitHub side alone simply worked, and GitLab fell behind in
 * silence — with no CI job exercising GitLab at all, nothing would have said so.
 *
 * This is the ledger of the gaps that exist today, and it may only shrink.
 * Closing one means deleting its entry. Opening one means editing this file on
 * purpose and filing a parity ticket, which is exactly when that decision
 * should become visible to a reviewer.
 *
 * The guards read `typeof adapter.method === "function"`, which is a fact about
 * the prototype, so the prototypes are what this checks. No instance, no
 * credentials, and no chance of a constructor reaching the network.
 */

type GuardName = Extract<keyof typeof vcs, `has${string}Capability`>;

/**
 * The other place a gap can hide: a member declared optional on the base
 * adapter surface rather than split out into a capability interface.
 */
type OptionalMember = {
  [K in keyof VCSAdapter]-?: Record<never, never> extends Pick<VCSAdapter, K> ? K : never;
}[keyof VCSAdapter];

type Support = "both" | "github-only";

/**
 * Exhaustive by construction. Export a new capability guard without listing it
 * here and `pnpm typecheck` fails before any test runs.
 */
const CAPABILITY_LEDGER: Record<GuardName, Support> = {
  hasGateStatusCapability: "both",
  hasManualDispatchPrCapability: "both",
  hasPRFilesCapability: "both",
  hasPRReviewCapability: "both",
  // GitLab has no equivalent of a Check Run's rich detail payload.
  hasRichGateStatusCapability: "github-only",
};

/** Exhaustive in the same way, over the optional members of `VCSAdapter`. */
const OPTIONAL_MEMBER_LEDGER: Record<OptionalMember, Support> = {
  // Only GitHub exposes Check Run identities; `types.ts` says so at the
  // declaration, and this is where that claim is held to account.
  getLatestCheckRuns: "github-only",
};

const github = GitHubAdapter.prototype as unknown as VCSAdapter;
const gitlab = GitLabAdapter.prototype as unknown as VCSAdapter;

const CLOSE = "Closing a gap is good: delete its entry here. This list may only shrink.";
const OPEN =
  "Adding a GitHub-only capability widens the parity gap. Implement it for GitLab, or declare it here and file a parity ticket.";

describe("GitLab capability gap ledger", () => {
  const guards = Object.entries(CAPABILITY_LEDGER) as Array<[GuardName, Support]>;

  it.each(guards)("%s is implemented where the ledger says it is", (name, support) => {
    const guard = vcs[name] as unknown as (adapter: VCSAdapter) => boolean;

    expect(guard(github), `GitHubAdapter must implement ${name}. ${CLOSE}`).toBe(true);
    expect(
      guard(gitlab),
      support === "both"
        ? `GITLAB_CAPABILITY_GAPS says GitLab implements ${name}, but it does not. ${OPEN}`
        : `The ledger records ${name} as a GitLab gap, but GitLabAdapter now implements it. ${CLOSE}`,
    ).toBe(support === "both");
  });

  const members = Object.entries(OPTIONAL_MEMBER_LEDGER) as Array<[OptionalMember, Support]>;

  it.each(members)("optional member %s matches the ledger", (name, support) => {
    const onGitHub = typeof github[name] === "function";
    const onGitLab = typeof gitlab[name] === "function";

    expect(onGitHub, `GitHubAdapter must implement ${name}. ${CLOSE}`).toBe(true);
    expect(
      onGitLab,
      support === "both"
        ? `The ledger says GitLab implements ${name}, but it does not. ${OPEN}`
        : `The ledger records ${name} as a GitLab gap, but GitLabAdapter now implements it. ${CLOSE}`,
    ).toBe(support === "both");
  });

  it("declares every capability guard the adapter surface exports", () => {
    const exported = Object.keys(vcs)
      .filter((key) => /^has[A-Z]\w*Capability$/.test(key))
      .sort();

    expect(
      exported,
      "a capability guard exists that the ledger does not classify; add it to CAPABILITY_LEDGER",
    ).toEqual(Object.keys(CAPABILITY_LEDGER).sort());
  });
});
