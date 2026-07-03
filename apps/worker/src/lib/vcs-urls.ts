/** Bare clone URL with no auth. */
export function buildCloneUrl(config: { host: string; repoPath: string }): string {
  const host = config.host.replace(/\/+$/, "");
  return `${host}/${config.repoPath}.git`;
}

/**
 * Build clone/push URLs for the configured VCS. The caller resolves the token
 * just-in-time and passes it as the second arg, so this function stays pure
 * and does not capture credentials.
 */
export function buildVcsUrls(
  config: { kind: "github" | "gitlab"; repoPath: string; host: string },
  token: string,
) {
  const host = config.host.replace(/\/+$/, "");
  const scheme = host.match(/^https?:\/\//)?.[0] ?? "https://";
  const hostNoScheme = host.replace(/^https?:\/\//, "");
  const authUser = config.kind === "gitlab" ? "oauth2" : "x-access-token";
  return {
    cloneUrl: buildCloneUrl(config),
    authUrl: `${scheme}${authUser}:${token}@${hostNoScheme}/${config.repoPath}.git`,
    authUser,
  };
}
