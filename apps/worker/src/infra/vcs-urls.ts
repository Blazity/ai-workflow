/** Bare clone URL with no auth. */
export function buildCloneUrl(config: { host: string; repoPath: string }): string {
  const host = config.host.replace(/\/+$/, "");
  return `${host}/${config.repoPath}.git`;
}

export function buildVcsUrls(
  config: { repoPath: string; host: string; authUser?: string },
) {
  return {
    cloneUrl: buildCloneUrl(config),
    authUser: config.authUser ?? "x-access-token",
  };
}

export function gitAuthArgs(authUser: string, token: string): string[] {
  const credentials = Buffer.from(`${authUser}:${token}`, "utf8").toString("base64");
  return ["-c", `http.extraHeader=AUTHORIZATION: Basic ${credentials}`];
}
