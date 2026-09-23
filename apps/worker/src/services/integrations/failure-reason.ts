/**
 * What a failure that carried no verdict says, in words somebody can act on.
 *
 * A connection test that threw and a health probe that threw both end up here:
 * the provider was not reached or did not answer, and the admin reading the
 * sentence has to tell a typo from an outage without a debugger. Neither
 * function redacts; the caller does, with the secrets it holds.
 */

/**
 * What an error says, including what it hides in its cause: `fetch` throws a
 * flat "fetch failed" and keeps "connect ECONNREFUSED" underneath, and the
 * second half is the one somebody can act on.
 */
export function failureReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  const detail = cause instanceof Error ? cause.message : undefined;
  return detail && !error.message.includes(detail)
    ? `${error.message}: ${detail}`
    : error.message;
}

/**
 * The reason a connection test that got no answer gives.
 *
 * A host that does not resolve is the one no-verdict failure a person usually
 * caused, by typing the site address: `getaddrinfo ENOTFOUND` on a typed host
 * names the host and the field it came from. It stays no verdict (a VPN that
 * is down says the same about a host that exists), so the sentence covers
 * both. Any other failure reads as `failureReason`.
 */
export function noVerdictReason(
  error: unknown,
  fields: readonly { readonly label: string; readonly value: string }[],
): string {
  const host = unresolvedHost(error);
  if (host === null) return failureReason(error);
  const field = fields.find((candidate) => hostOf(candidate.value) === host);
  return field
    ? `The host ${host} could not be found (getaddrinfo ENOTFOUND). Check the ${field.label}; if it is right, this deployment cannot resolve it at the moment.`
    : `The host ${host} could not be found (getaddrinfo ENOTFOUND), so this deployment cannot reach the provider at the moment.`;
}

/** How far down a cause chain to look; Octokit wraps Node's `fetch failed`,
 *  which wraps the DNS error, and core's redacted copy keeps that chain. */
const MAX_CAUSE_DEPTH = 4;

/** The host a DNS lookup failed for, from Node's error (`code` ENOTFOUND with a
 *  `hostname`) anywhere in the cause chain, or from a message that quotes it. */
function unresolvedHost(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    const { code, hostname } = current as { code?: unknown; hostname?: unknown };
    if (code === "ENOTFOUND" && typeof hostname === "string" && hostname.length > 0) {
      return hostname.toLowerCase();
    }
    const quoted = /\bgetaddrinfo ENOTFOUND (\S+)/u.exec(current.message)?.[1];
    if (quoted) return quoted.toLowerCase();
    current = current.cause;
  }
  return null;
}

function hostOf(value: string): string | null {
  return URL.canParse(value) ? new URL(value).hostname.toLowerCase() : null;
}
