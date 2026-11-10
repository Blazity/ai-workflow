import {
  isManagedGateCheckName,
  vcsLoginsMatch,
  type PullRequestFailedCheck,
  type VcsHandleIdentity,
  type VcsOpaqueHandle,
} from "@integrations/sdk";

/**
 * How a Bitbucket build status becomes a failed check, and how two of them
 * compare. One home, because the webhook, the head re-read that binds a
 * delivery and the manual dispatch snapshot all mint these handles, and core
 * compares a handle one of them minted with one another minted.
 *
 * A build status is identified by its `key` on one commit: Bitbucket
 * overwrites a status posted again with the same key on the same commit
 * (API reference, "Create a build status for a commit").
 */
type BitbucketCheckHandle = { kind: "build_status"; key: string; commit: string };

/** A build status as the commit statuses API and the webhook report it. */
export interface BitbucketCommitStatus {
  key?: string;
  name?: string;
  state?: string;
  url?: string;
  description?: string;
}

function statusHandle(key: string, commit: string): VcsOpaqueHandle {
  return { kind: "build_status", key, commit } satisfies BitbucketCheckHandle as unknown as VcsOpaqueHandle;
}

/** A failed status as a failed check, or `null` when it did not fail or is
 *  this product's own gate status. */
export function failedStatusCheck(
  status: BitbucketCommitStatus,
  commit: string,
): (PullRequestFailedCheck & { detailsUrl?: string }) | null {
  if (status.state !== "FAILED" || typeof status.key !== "string") return null;
  const name = status.name || status.key;
  if (isManagedGateCheckName(name)) return null;
  return {
    handle: statusHandle(status.key, commit),
    name,
    conclusion: "failed",
    ...(typeof status.url === "string" && status.url ? { detailsUrl: status.url } : {}),
  };
}

export const bitbucketHandleIdentity: VcsHandleIdentity = {
  sameHandle(left, right) {
    if (!left || !right) return left === right;
    const a = left as unknown as Partial<BitbucketCheckHandle>;
    const b = right as unknown as Partial<BitbucketCheckHandle>;
    return a.kind === b.kind && a.key === b.key && a.commit === b.commit;
  },
};

/**
 * Who reports a build status, as a trigger names its producer: the status
 * key, which is the build system's own identifier (`BB-DEPLOY` in the API
 * reference). Any account with write access can post a status under any key,
 * so none is trusted until a workflow names it.
 */
export function statusProducer(status: BitbucketCommitStatus): string {
  return typeof status.key === "string" && status.key ? status.key : "unknown";
}

/** An account as Bitbucket's API and webhooks carry it (`account`, `user`). */
export interface BitbucketAccount {
  type?: string;
  uuid?: string;
  account_id?: string;
  nickname?: string;
  display_name?: string;
}

function identifiersOf(account: BitbucketAccount | null | undefined): string[] {
  if (!account) return [];
  return [account.nickname, account.display_name, account.uuid, account.account_id].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

/**
 * Whether an account is this deployment's own: the account `GET /user`
 * answered for the token (by UUID), or the bot account an admin named, which
 * may be the access token's name as Bitbucket shows it, its nickname or its
 * UUID. An access token is shown under its name, and `GET /user` needs the
 * `account` scope a repository access token cannot have, so the field is the
 * fallback that always works.
 */
export function isOwnAccount(
  account: BitbucketAccount | null | undefined,
  self: { uuid?: string | null; botLogin?: string | undefined },
): boolean {
  if (!account) return false;
  if (self.uuid && account.uuid === self.uuid) return true;
  return identifiersOf(account).some((identifier) => vcsLoginsMatch(identifier, self.botLogin));
}

/**
 * The login a trigger or a comment names an account by: the configured bot
 * login itself when the account is the bot (so core, which compares the
 * producer with that same login, agrees), otherwise its nickname, its display
 * name or its UUID, in that order.
 */
export function accountLogin(account: BitbucketAccount | null | undefined, botLogin?: string): string {
  if (botLogin && isOwnAccount(account, { botLogin })) return botLogin;
  return identifiersOf(account)[0] ?? "unknown";
}
