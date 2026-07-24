import type { TicketContent } from "../adapters/issue-tracker/types.js";
import type { PreSandboxRepositoryDiscovery } from "../pre-sandbox/types.js";
import type { ResearchRepository } from "../sandbox/agents/types.js";
import {
  repositoryCatalogKey,
  type RepositoryCatalogEntry,
} from "./catalog.js";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";

export const REPOSITORY_DISCOVERY_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["selected", "clarification_needed", "failed"],
    },
    repositories: {
      anyOf: [
        {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              provider: { type: "string", enum: ["github", "gitlab"] },
              repoPath: { type: "string" },
              rationale: { type: "string" },
            },
            required: ["provider", "repoPath", "rationale"],
            additionalProperties: false,
          },
        },
        { type: "null" },
      ],
    },
    confidence: {
      anyOf: [
        { type: "string", enum: ["high", "medium", "low"] },
        { type: "null" },
      ],
    },
    questions: {
      anyOf: [
        { type: "array", maxItems: 3, items: { type: "string" } },
        { type: "null" },
      ],
    },
    error: { type: ["string", "null"] },
  },
  required: ["status", "repositories", "confidence", "questions", "error"],
  additionalProperties: false,
});

export function assembleRepositoryDiscoveryPrompt(input: {
  ticket: Pick<
    TicketContent,
    | "identifier"
    | "title"
    | "description"
    | "acceptanceCriteria"
    | "comments"
    | "labels"
  >;
  discovery: PreSandboxRepositoryDiscovery;
}): string {
  return [
    "Select the smallest sufficient repository set for researching this ticket.",
    "Use only exact provider and repoPath values from the server-owned catalog.",
    "Return at most 3 repositories. Use medium/high confidence only when evidence is concrete.",
    "If the evidence is ambiguous, request clarification instead of guessing.",
    "",
    "Ticket:",
    JSON.stringify(input.ticket),
    "",
    "Mandatory repositories (always include):",
    JSON.stringify(
      input.discovery.mandatoryRepositories.map(({ provider, repoPath }) => ({
        provider,
        repoPath,
      })),
    ),
    "",
    "Accessible repository catalog:",
    JSON.stringify(input.discovery.catalog),
  ].join("\n");
}

export type RepositoryExpansionDecision =
  | { kind: "attach"; repositories: SelectedRepository[] }
  | { kind: "clarification_needed"; questions: string[] };

// Total repositories one research workspace may ever hold. This is a hard cap:
// no path (model round or human answer) may exceed it.
const MAX_WORKSPACE_REPOSITORIES = 8;

// The single documented parsing rule for a human clarification answer. Repeated
// verbatim in the expansion-limit clarification so a human knows the exact shape
// an actionable answer must take.
const EXPANSION_ANSWER_FORMAT =
  'reply with exact repository paths as "github:owner/repo" or "gitlab:group/repo"' +
  ' (a bare "owner/repo" also works and is matched against the accessible catalog,' +
  " case-insensitively). Separate multiple repositories with commas or new lines.";

// Stable leading sentence of the expansion-limit clarification. The planning
// block matches on this prefix to recognize that a human answer to THIS
// clarification must attach repositories beyond the model round limit.
export const EXPANSION_LIMIT_CLARIFICATION_PREFIX =
  "Research already used the maximum of 2 repository expansion rounds.";

/** True when a clarification's questions include the expansion-limit prompt, so a
 *  human answer to it should be parsed as repositories to attach. */
export function isExpansionLimitClarification(questions: string[]): boolean {
  return questions.some((question) =>
    question.startsWith(EXPANSION_LIMIT_CLARIFICATION_PREFIX),
  );
}

export function validateRepositoryExpansionRequests(input: {
  requests: ResearchRepository[];
  catalog: RepositoryCatalogEntry[];
  attached: Array<Pick<SelectedRepository, "provider" | "repoPath">>;
  completedRounds: number;
}): RepositoryExpansionDecision {
  if (input.completedRounds >= 2) {
    return clarification(
      `${EXPANSION_LIMIT_CLARIFICATION_PREFIX} To attach more, ${EXPANSION_ANSWER_FORMAT}` +
        ` Only repositories on the accessible catalog can be attached, and the` +
        ` ${MAX_WORKSPACE_REPOSITORIES}-repository workspace limit still applies.`,
    );
  }
  if (input.requests.length === 0) {
    return clarification(
      "Research requested more repository context without naming a repository. Which repository is required?",
    );
  }
  if (input.requests.length > 3) {
    return clarification(
      "Research requested more than 3 repositories in one round. Which 3 are essential?",
    );
  }
  const catalog = new Map(
    input.catalog.map((repository) => [
      repositoryCatalogKey(repository),
      repository,
    ]),
  );
  const attached = new Set(input.attached.map(repositoryCatalogKey));
  const requested = new Set<string>();
  const repositories: SelectedRepository[] = [];
  for (const request of input.requests) {
    const key = repositoryCatalogKey(request);
    if (requested.has(key)) {
      return clarification(
        `Research requested ${request.provider}:${request.repoPath} more than once.`,
      );
    }
    requested.add(key);
    if (attached.has(key)) {
      return clarification(
        `Research requested ${request.provider}:${request.repoPath}, but it is already attached. Which additional repository is required?`,
      );
    }
    const repository = catalog.get(key);
    if (!repository?.usable) {
      return clarification(
        `Research requested unavailable repository ${request.provider}:${request.repoPath}. Which accessible repository should be used?`,
      );
    }
    repositories.push({
      provider: repository.provider,
      repoPath: repository.repoPath,
      defaultBranch: repository.defaultBranch,
      selectedRationale: request.rationale,
    });
  }
  if (input.attached.length + repositories.length > MAX_WORKSPACE_REPOSITORIES) {
    return clarification(
      `Attaching those repositories would exceed the ${MAX_WORKSPACE_REPOSITORIES}-repository workspace limit. Which repositories are essential?`,
    );
  }
  return { kind: "attach", repositories };
}

export interface ParsedRepositoryIdentity {
  provider?: "github" | "gitlab";
  repoPath: string;
}

/**
 * Parse a human clarification answer into repository identities. The one rule:
 * split on whitespace, commas, and new lines; a token is an identity when it is
 * "github:owner/repo" / "gitlab:group/repo" (provider-scoped) or a bare
 * "owner/repo" path (at least one slash). Surrounding punctuation is trimmed;
 * everything else (prose, URLs, unknown prefixes) is ignored.
 */
export function parseRepositoryExpansionAnswer(
  answer: string,
): ParsedRepositoryIdentity[] {
  const identities: ParsedRepositoryIdentity[] = [];
  for (const rawToken of answer.split(/[\s,]+/)) {
    const token = normalizeToken(rawToken);
    if (token.length === 0) continue;
    const identity = parseIdentityToken(token);
    if (identity) identities.push(identity);
  }
  return identities;
}

/**
 * Validate a human clarification answer against a fresh server-owned catalog and
 * the allowlist. Human authority outranks the model round limit, so there is no
 * round check here, but every other server-side rule still holds: nothing
 * off-catalog or off-allowlist may attach, only usable repositories count,
 * already-attached repositories are skipped silently, and the hard workspace cap
 * is never exceeded.
 */
export function validateHumanRepositoryExpansion(input: {
  answer: string;
  catalog: RepositoryCatalogEntry[];
  attached: Array<Pick<SelectedRepository, "provider" | "repoPath">>;
  isAllowed?: (repoPath: string) => boolean;
}): RepositoryExpansionDecision {
  const isAllowed = input.isAllowed ?? (() => true);
  const identities = parseRepositoryExpansionAnswer(input.answer);
  if (identities.length === 0) {
    return clarification(
      `No repository paths were recognized. To attach repositories, ${EXPANSION_ANSWER_FORMAT}`,
    );
  }
  const byKey = new Map(
    input.catalog.map((repository) => [
      repositoryCatalogKey(repository),
      repository,
    ]),
  );
  const byPath = new Map<string, RepositoryCatalogEntry[]>();
  for (const entry of input.catalog) {
    const path = entry.repoPath.toLowerCase();
    const list = byPath.get(path) ?? [];
    list.push(entry);
    byPath.set(path, list);
  }
  const attached = new Set(input.attached.map(repositoryCatalogKey));
  const seen = new Set<string>();
  const repositories: SelectedRepository[] = [];
  for (const identity of identities) {
    const resolved = resolveIdentity(identity, byKey, byPath);
    if (resolved.kind === "ambiguous") {
      return clarification(
        `${identity.repoPath} exists on more than one provider. Reply with a` +
          ` provider-scoped path such as ${resolved.providers
            .map((provider) => `${provider}:${identity.repoPath}`)
            .join(" or ")}.`,
      );
    }
    if (resolved.kind === "unknown") {
      return clarification(
        `${describeIdentity(identity)} is not on the accessible repository` +
          ` catalog. To attach repositories, ${EXPANSION_ANSWER_FORMAT}`,
      );
    }
    const entry = resolved.entry;
    if (!entry.usable || !isAllowed(entry.repoPath)) {
      return clarification(
        `${entry.provider}:${entry.repoPath} cannot be attached. To attach` +
          ` repositories, ${EXPANSION_ANSWER_FORMAT}`,
      );
    }
    const key = repositoryCatalogKey(entry);
    // Already-attached and repeated identities are skipped silently, never an error.
    if (attached.has(key) || seen.has(key)) continue;
    seen.add(key);
    repositories.push({
      provider: entry.provider,
      repoPath: entry.repoPath,
      defaultBranch: entry.defaultBranch,
      selectedRationale: "requested by human clarification answer",
    });
  }
  if (input.attached.length + repositories.length > MAX_WORKSPACE_REPOSITORIES) {
    return clarification(
      `Attaching those repositories would exceed the ${MAX_WORKSPACE_REPOSITORIES}-repository` +
        ` workspace limit. Reply with a smaller set of essential repositories.`,
    );
  }
  return { kind: "attach", repositories };
}

type ResolvedIdentity =
  | { kind: "entry"; entry: RepositoryCatalogEntry }
  | { kind: "ambiguous"; providers: string[] }
  | { kind: "unknown" };

function resolveIdentity(
  identity: ParsedRepositoryIdentity,
  byKey: Map<string, RepositoryCatalogEntry>,
  byPath: Map<string, RepositoryCatalogEntry[]>,
): ResolvedIdentity {
  if (identity.provider) {
    const entry = byKey.get(
      repositoryCatalogKey({
        provider: identity.provider,
        repoPath: identity.repoPath,
      }),
    );
    return entry ? { kind: "entry", entry } : { kind: "unknown" };
  }
  const matches = byPath.get(identity.repoPath.toLowerCase()) ?? [];
  if (matches.length === 0) return { kind: "unknown" };
  if (matches.length === 1) return { kind: "entry", entry: matches[0] };
  return { kind: "ambiguous", providers: matches.map((match) => match.provider) };
}

function parseIdentityToken(token: string): ParsedRepositoryIdentity | null {
  const colon = token.indexOf(":");
  if (colon > 0) {
    const prefix = token.slice(0, colon).toLowerCase();
    if (prefix === "github" || prefix === "gitlab") {
      const repoPath = token.slice(colon + 1);
      return repoPath.includes("/") ? { provider: prefix, repoPath } : null;
    }
    return null;
  }
  return token.includes("/") ? { repoPath: token } : null;
}

// Strip leading/trailing wrapping punctuation (backticks, quotes, angle
// brackets, trailing periods) while keeping the "/", ":", ".", "-", "_" that are
// legal inside provider-scoped and nested paths.
function normalizeToken(token: string): string {
  return token.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
}

function describeIdentity(identity: ParsedRepositoryIdentity): string {
  return identity.provider
    ? `${identity.provider}:${identity.repoPath}`
    : identity.repoPath;
}

function clarification(question: string): RepositoryExpansionDecision {
  return { kind: "clarification_needed", questions: [question] };
}
