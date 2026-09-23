/**
 * A 4xx from the sandbox service, turned into a sentence a person can act on.
 *
 * The SDK's own message for a refused request is only "Status code 400 is not
 * ok", which names nothing: that is what a person read on the ticket when a
 * re-run tried to check out a branch that had been deleted. The service's
 * reason, when its body carries one, is kept beside what was being created.
 * Anything that is not a 4xx (a 5xx, a network failure) returns null and is
 * rethrown as it came: those are infrastructure faults, and rewording them
 * would hide that.
 *
 * Pure and dependency free, so every step that creates a sandbox can import it
 * statically.
 */
export function sandboxCreateRefusal(
  error: unknown,
  /** The git source the sandbox was being created from, when it had one. */
  source?: { provider: string; repoPath: string; branchName: string },
): Error | null {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  if (typeof status !== "number" || status < 400 || status >= 500) return null;
  const reason = serviceReason((error as { json?: unknown }).json);
  const what = source
    ? `The workspace could not be created from ${source.provider}:${source.repoPath} at branch ${source.branchName}`
    : "A sandbox could not be created";
  const hint = refusalHint(status, source !== undefined);
  return new Error(
    `${what}: the sandbox service refused it (HTTP ${status}${reason ? `: ${reason}` : ""}).${
      hint ? ` ${hint}` : ""
    }`,
    { cause: error },
  );
}

function refusalHint(status: number, fromGit: boolean): string | null {
  if (status === 401 || status === 403) {
    return fromGit
      ? "Check the sandbox credentials and the repository token."
      : "Check the sandbox credentials.";
  }
  if (status === 402) return "Check the Vercel account's sandbox plan and usage.";
  if (status === 429) return "Too many sandboxes or requests at once; try again shortly.";
  return fromGit ? "Check that the branch exists and that the repository token can read it." : null;
}

function serviceReason(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const body = json as { error?: unknown; message?: unknown };
  const nested =
    body.error && typeof body.error === "object"
      ? (body.error as { message?: unknown }).message
      : body.error;
  const text =
    typeof nested === "string" ? nested : typeof body.message === "string" ? body.message : null;
  const trimmed = text?.trim().slice(0, 300);
  return trimmed ? trimmed : null;
}
