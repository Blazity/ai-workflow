import type { VcsHandleIdentity, VcsOpaqueHandle } from "@integrations/sdk";

/**
 * What a GitHub handle holds, and how two of them compare.
 *
 * One home, because a check run's handle is minted in three places (the
 * webhook's `check_run` delivery, the head read that binds it, and the manual
 * dispatch snapshot) and compared with a handle from another of them. They
 * must agree on the shape, or a failed check binds to nothing and the autofix
 * path goes silent.
 *
 * - A check run someone else reported: its id and the app that reported it,
 *   `owner` being the app's slug, or the empty string when GitHub names none.
 * - A gate check run of ours: `provider: "github"` and its id.
 */
export type GitHubHandle = {
  provider?: "github";
  id?: number;
  owner?: string;
};

export function githubHandle(value: GitHubHandle): VcsOpaqueHandle {
  return value as unknown as VcsOpaqueHandle;
}

/** A check run another app reported, the same whichever side read it. */
export function checkRunHandle(check: { id: number; appSlug: string | undefined }): VcsOpaqueHandle {
  return githubHandle({ id: check.id, owner: check.appSlug ?? "" });
}

/**
 * Whether a check run's app is trusted when a workflow names no producers.
 * Only GitHub's own runner is: widening this to every app would start runs
 * from check runs an outside app reported. Here beside the handle for the same
 * reason: the webhook and the manual dispatch snapshot both ask, so the two
 * ways a failed check arrives agree.
 */
export function isTrustedByDefaultCheckProducer(appSlug: string | undefined): boolean {
  return appSlug === "github-actions";
}

export const githubHandleIdentity: VcsHandleIdentity = {
  sameHandle(left, right) {
    if (!left || !right) return left === right;
    const a = left as unknown as GitHubHandle;
    const b = right as unknown as GitHubHandle;
    return a.provider === b.provider && a.id === b.id && a.owner === b.owner;
  },

  // Main recorded a failed check run as `checkRunId` with its app beside it as
  // `appSlug`, which is the pair a handle holds now. A slugless app was
  // recorded under the sender's login then, so such a check never matched on
  // main either; it does not match here.
  recordedCheckHandle(check) {
    const { checkRunId, appSlug } = check;
    if (typeof checkRunId !== "number") return null;
    return checkRunHandle({
      id: checkRunId,
      appSlug: typeof appSlug === "string" ? appSlug : undefined,
    });
  },
};
