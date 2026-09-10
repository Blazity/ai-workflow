/** Bare clone URL with no auth. */
export function buildCloneUrl(config: { host: string; repoPath: string }): string {
  const host = config.host.replace(/\/+$/, "");
  return `${host}/${config.repoPath}.git`;
}

export function buildVcsUrls(
  config: { kind: "github" | "gitlab"; repoPath: string; host: string },
) {
  const authUser = config.kind === "gitlab" ? "oauth2" : "x-access-token";
  return {
    cloneUrl: buildCloneUrl(config),
    authUser,
  };
}

export function gitAuthArgs(authUser: string, token: string): string[] {
  const credentials = Buffer.from(`${authUser}:${token}`, "utf8").toString("base64");
  return ["-c", `http.extraHeader=AUTHORIZATION: Basic ${credentials}`];
}
