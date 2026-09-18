import type { RepositoryKey, RepositoryRelationshipKind } from "@shared/contracts";

// Below this many requestable repositories the whole catalog is rendered. The
// cap bounds context, not choice, and it hurts most on the discovery path where
// nothing is attached yet and only the lexical signal ranks.
const MAP_FULL_LISTING_MAX = 25;
const MAP_CAPPED_LINES = 12;
const MAP_DESCRIPTION_MAX_LENGTH = 120;
// The contract's bound on a recorded map_shown text.
const MAP_TEXT_MAX_LENGTH = 1600;
// Shorter words ("fix", "the", "api") match nearly every repository.
const TICKET_WORD_MIN_LENGTH = 4;

export interface RepositoryMapRepository {
  key: RepositoryKey;
  description: string;
  relationships: Array<{ kind: RepositoryRelationshipKind; targetKey: RepositoryKey }>;
  /** True when a request for this repository asks a person before anything is
   *  attached: it sits outside the trigger's candidates under an `ask_once`
   *  expansion, or the catalog does not have it usable yet. The map still
   *  lists it, because a request for it is the only way that question gets
   *  asked, and the agent is told the cost up front rather than discovering it
   *  as a refusal. */
  asksFirst: boolean;
}

export interface RepositoryMap {
  text: string;
  /** Exactly the keys shown, in the order shown. */
  repositoryKeys: RepositoryKey[];
}

const RANK_ONE_HOP = 0;
const RANK_TWO_HOPS = 1;
const RANK_TICKET_WORDS = 2;
const RANK_IN_SCOPE = 3;
const RANK_REST = 4;

/**
 * The compact index of what the run may request, rendered into the agent's
 * context. Deterministic and model free, so it costs nothing and a replay
 * renders the same text. It never narrows what may be requested: the final
 * line tells the agent how many more exist and that it may ask for them.
 */
export function renderRepositoryMap(input: {
  /** Every catalog key inside the definition pin (its providers and its
   *  repositories), each marked with `asksFirst`, minus the keys carrying a
   *  blocking entry (a person's exclusion, or an unavailable entry that has not
   *  expired): those are settled, and listing them only invites a request that
   *  is refused. The trigger policy narrows nothing here, or the model would
   *  never request a repository outside the candidate set, nobody would ever be
   *  asked about one, and `ask_once` could not fire. May include attached keys,
   *  which are not listed. */
  repositories: RepositoryMapRepository[];
  attachedKeys: RepositoryKey[];
  ticketText: string;
  scopeKeys: RepositoryKey[];
}): RepositoryMap {
  const attached = new Set(input.attachedKeys);
  const neighbours = relationshipNeighbours(input.repositories);
  const oneHop = new Set<string>();
  for (const key of attached) {
    for (const neighbour of neighbours.get(key) ?? []) {
      if (!attached.has(neighbour)) oneHop.add(neighbour);
    }
  }
  const twoHops = new Set<string>();
  for (const key of oneHop) {
    for (const neighbour of neighbours.get(key) ?? []) {
      if (!attached.has(neighbour) && !oneHop.has(neighbour)) twoHops.add(neighbour);
    }
  }
  const ticketWords = new Set(
    wordsOf(input.ticketText).filter((word) => word.length >= TICKET_WORD_MIN_LENGTH),
  );
  const scope = new Set(input.scopeKeys);

  const ranked = input.repositories
    .filter((repository) => !attached.has(repository.key))
    .map((repository) => {
      const matches = ticketWordMatches(repository, ticketWords);
      const rank = oneHop.has(repository.key)
        ? RANK_ONE_HOP
        : twoHops.has(repository.key)
          ? RANK_TWO_HOPS
          : matches > 0
            ? RANK_TICKET_WORDS
            : scope.has(repository.key)
              ? RANK_IN_SCOPE
              : RANK_REST;
      return { repository, rank, matches: rank === RANK_TICKET_WORDS ? matches : 0 };
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        right.matches - left.matches ||
        compareKeys(left.repository.key, right.repository.key),
    );

  const shown =
    ranked.length > MAP_FULL_LISTING_MAX ? ranked.slice(0, MAP_CAPPED_LINES) : ranked;
  const lines = shown.map(({ repository }) => ({
    key: repository.key,
    line: repositoryLine(repository, attached),
  }));
  let hidden = ranked.length - lines.length;
  let text = mapText(lines, hidden);
  while (text.length > MAP_TEXT_MAX_LENGTH && lines.length > 0) {
    lines.pop();
    hidden += 1;
    text = mapText(lines, hidden);
  }
  return { text, repositoryKeys: lines.map((entry) => entry.key) };
}

/** Undirected: a relationship makes both ends neighbours whichever side
 *  recorded it. */
function relationshipNeighbours(
  repositories: RepositoryMapRepository[],
): Map<string, Set<string>> {
  const neighbours = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    const set = neighbours.get(from) ?? new Set<string>();
    set.add(to);
    neighbours.set(from, set);
  };
  for (const repository of repositories) {
    for (const relationship of repository.relationships) {
      link(repository.key, relationship.targetKey);
      link(relationship.targetKey, repository.key);
    }
  }
  return neighbours;
}

function ticketWordMatches(repository: RepositoryMapRepository, ticketWords: Set<string>): number {
  const path = repository.key.slice(repository.key.indexOf(":") + 1);
  const own = new Set([
    ...path.toLowerCase().split(/[/\-_.]+/),
    ...wordsOf(repository.description),
  ]);
  let matches = 0;
  for (const word of ticketWords) {
    if (own.has(word)) matches += 1;
  }
  return matches;
}

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

// Plain code unit order, so the ranking never depends on the runtime's locale.
function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repositoryLine(repository: RepositoryMapRepository, attached: Set<string>): string {
  const summary = firstSentence(repository.description);
  const related = repository.relationships
    .filter((relationship) => attached.has(relationship.targetKey))
    .map((relationship) => `${relationship.kind} ${relationship.targetKey}`);
  return (
    `- ${repository.key}${summary.length > 0 ? `: ${summary}` : ""}` +
    (related.length > 0 ? ` (related: ${related.join(", ")})` : "") +
    (repository.asksFirst ? " (asks first)" : "")
  );
}

function firstSentence(description: string): string {
  const collapsed = description.replace(/\s+/g, " ").trim();
  const sentence = /^.*?[.!?](?=\s|$)/.exec(collapsed)?.[0] ?? collapsed;
  return sentence.slice(0, MAP_DESCRIPTION_MAX_LENGTH);
}

function mapText(lines: Array<{ line: string }>, hidden: number): string {
  const rendered = lines.map((entry) => entry.line);
  if (hidden > 0) {
    rendered.push(
      `${hidden} more ${hidden === 1 ? "repository" : "repositories"} may be requested; ask for the rest of the map to see them.`,
    );
  }
  return rendered.join("\n");
}
